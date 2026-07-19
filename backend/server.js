import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { exiftool } from "exiftool-vendored";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import https from "https";
import crypto from "crypto";
import { exec } from "child_process";

dotenv.config();

// Helper function to perform HTTPS POST request using native Node https module
function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    console.log("httpsPost URL:", url);
    console.log("httpsPost headers:", JSON.stringify(options.headers, null, 2));

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(data),
          json: () => {
            try {
              return Promise.resolve(JSON.parse(data));
            } catch (e) {
              return Promise.reject(new Error("Invalid JSON: " + data));
            }
          }
        });
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(body);
    req.end();
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Cache helper functions
const activeResizeJobs = new Map();

function getCachePath(filePath, size) {
  const hash = crypto.createHash("md5").update(filePath).digest("hex");
  const cacheDir = path.join(process.cwd(), ".cache", size);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return path.join(cacheDir, `${hash}.jpg`);
}

function generateResizedImage(srcPath, destPath, maxDim) {
  const key = destPath;
  if (activeResizeJobs.has(key)) {
    return activeResizeJobs.get(key);
  }

  const promise = new Promise((resolve, reject) => {
    exec(`sips -Z ${maxDim} "${srcPath}" --out "${destPath}"`, (err, stdout, stderr) => {
      activeResizeJobs.delete(key);
      if (err) {
        console.error("sips error:", stderr);
        return reject(err);
      }
      resolve();
    });
  });

  activeResizeJobs.set(key, promise);
  return promise;
}

// Endpoint to stream local images to browser
app.get("/api/image", async (req, res) => {
  const filePath = req.query.path;
  const size = req.query.size; // 'thumbnail' (300px) or 'preview' (1200px)

  if (!filePath) {
    return res.status(400).send("Path is required");
  }

  // Basic check to ensure file exists and is an image
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  const ext = path.extname(filePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".heic", ".heif"].includes(ext)) {
    return res.status(400).send("Only JPG/JPEG/PNG/HEIC images are supported");
  }

  // If a specific size cache is requested, OR if it's a HEIC file (since browsers can't render raw HEIC, we must convert it via sips)
  if (size === "thumbnail" || size === "preview" || ext === ".heic" || ext === ".heif") {
    const maxDim = size === "thumbnail" ? 300 : (size === "preview" ? 1200 : 4000);
    const cacheSizeName = size || "full";
    const cachePath = getCachePath(filePath, cacheSizeName);

    if (fs.existsSync(cachePath)) {
      return res.sendFile(cachePath);
    }

    try {
      await generateResizedImage(filePath, cachePath, maxDim);
      return res.sendFile(cachePath);
    } catch (err) {
      console.error(`Error generating ${cacheSizeName} for ${filePath}:`, err);
      // Fallback to sending the original file on resize error
      return res.sendFile(filePath);
    }
  }

  res.sendFile(filePath);
});


// Helper function to scan a directory recursively for images
async function scanDirectory(dirPath) {
  let images = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files/directories (like .DS_Store, .git, .Trash)
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      try {
        const subImages = await scanDirectory(fullPath);
        images = images.concat(subImages);
      } catch (err) {
        console.error(`Error scanning subfolder ${fullPath}:`, err);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      // Only include standard web formats and HEIC (JPG, JPEG, PNG, HEIC, HEIF)
      // Explicitly exclude RAW file formats (e.g. dng, cr2, cr3, nef, arw, orf, rw2, pef, raf, raw, etc.)
      const allowedExts = [".jpg", ".jpeg", ".png", ".heic", ".heif"];
      const rawExts = [".raw", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".rw2", ".pef", ".raf", ".tiff", ".tif"];

      if (allowedExts.includes(ext) && !rawExts.includes(ext)) {
        try {
          const stats = fs.statSync(fullPath);
          images.push({
            name: entry.name,
            path: fullPath,
            size: stats.size,
            metadata: null,
            analyzed: false
          });
        } catch (err) {
          console.error(`Error getting stats for file ${fullPath}:`, err);
        }
      }
    }
  }
  return images;
}

// Endpoint to natively pick a folder using macOS osascript
app.get("/api/pick-folder", (req, res) => {
  const script = `
    tell application (path to frontmost application as text)
      set myFolder to choose folder with prompt "Seleziona la cartella con le foto:"
      POSIX path of myFolder
    end tell
  `;
  exec(`osascript -e '${script}'`, (err, stdout, stderr) => {
    if (err) {
      console.error("osascript error:", stderr);
      return res.status(500).json({ error: "Folder selection failed or cancelled" });
    }
    const selectedPath = stdout.trim();
    if (selectedPath) {
      res.json({ success: true, path: selectedPath });
    } else {
      res.status(400).json({ error: "No folder selected" });
    }
  });
});

// Endpoint to scan a local directory for images
app.post("/api/scan", async (req, res) => {
  const { dirPath } = req.body;
  if (!dirPath) {
    return res.status(400).json({ error: "Directory path is required" });
  }

  let targetPath = dirPath;
  if (!fs.existsSync(targetPath)) {
    // Try to resolve common Mac directories for Mattia
    const homeDir = "/Users/mattiaianniello";
    const candidates = [
      path.join(homeDir, "Desktop", dirPath),
      path.join(homeDir, "Downloads", dirPath),
      path.join(homeDir, dirPath)
    ];
    const found = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isDirectory());
    if (found) {
      targetPath = found;
    } else {
      return res.status(400).json({ error: `Directory "${dirPath}" not found on local disk.` });
    }
  }

  try {
    const images = await scanDirectory(targetPath);
    res.json({ success: true, images, resolvedPath: targetPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to fetch metadata for a single image on demand
app.post("/api/image-metadata", async (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: "Valid file path is required" });
  }

  try {
    const stats = fs.statSync(filePath);
    let existingMetadata = {
      title: "",
      description: "",
      keywords: [],
      date: stats.mtime
    };

    try {
      const tags = await exiftool.read(filePath);
      const rawTitle = (tags.Title || tags.ObjectName || tags.XPTitle || "").toString().trim();
      const rawDesc = (tags.Description || tags.ImageDescription || tags.CaptionAbstract || tags.UserComment || tags.Comment || tags.XPComment || "").toString().trim();
      
      let kw = tags.Keywords || tags.Subject || tags.XPKeywords || [];
      if (!kw) {
        kw = [];
      } else if (typeof kw === "string") {
        kw = [kw];
      } else if (!Array.isArray(kw)) {
        kw = Array.from(kw);
      }
      const cleanedKeywords = kw.map(k => k.toString().trim()).filter(k => k !== "");

      existingMetadata = {
        title: rawTitle,
        description: rawDesc,
        keywords: cleanedKeywords,
        date: tags.DateTimeOriginal || tags.CreateDate || stats.mtime
      };
    } catch (err) {
      console.error(`Error reading metadata for ${filePath}:`, err);
    }

    res.json({
      success: true,
      metadata: existingMetadata,
      analyzed: !!(existingMetadata.title || existingMetadata.description || existingMetadata.keywords.length > 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to write metadata (IPTC/XMP) safely
app.post("/api/write-metadata", async (req, res) => {
  const { filePath, metadata } = req.body;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: "Valid file path is required" });
  }

  const { title, description, keywords } = metadata;

  try {
    // Write using exiftool
    // Keywords are written to both Keywords (IPTC) and Subject (XMP) for maximum compatibility with macOS Finder/Spotlight
    await exiftool.write(filePath, {
      Title: title,
      ObjectName: title,
      XPTitle: title,
      
      Description: description,
      ImageDescription: description,
      "Caption-Abstract": description,
      UserComment: description,
      Comment: description,
      XPComment: description,
      
      Keywords: keywords,
      Subject: keywords,
      XPKeywords: Array.isArray(keywords) ? keywords.join("; ") : keywords
    }, ["-overwrite_original"]);

    // Optionally clean up backup files created by exiftool (filename_original)
    const backupFile = filePath + "_original";
    if (fs.existsSync(backupFile)) {
      fs.unlinkSync(backupFile);
    }

    res.json({ success: true, message: "Metadata successfully written" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to run Gemini Vision analysis
app.post("/api/analyze-gemini", async (req, res) => {
  const { filePath, base64Image, customPrompt, landmarksDb, detectedPeople, globalTags } = req.body;
  
  let base64Data = "";
  if (base64Image) {
    base64Data = base64Image;
  } else {
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(400).json({ error: "Valid file path or base64 image data is required" });
    }
  }

  let apiKey = "";
  if (req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    const token = parts.length === 2 && parts[0] === "Bearer" ? parts[1] : req.headers.authorization;
    if (token && token.trim() !== "" && token.trim() !== "null" && token.trim() !== "undefined") {
      const cleanToken = token.trim();
      if (cleanToken.length >= 30 && cleanToken.toLowerCase() !== "bearer") {
        apiKey = cleanToken;
      }
    }
  }

  if (!apiKey) {
    apiKey = (process.env.GEMINI_API_KEY || "").trim();
  }

  // Auto-correct common typo: number 0 instead of capital O at character 11
  if (apiKey && apiKey.startsWith("AQ.Ab8RN6I20C")) {
    apiKey = apiKey.replace("AQ.Ab8RN6I20C", "AQ.Ab8RN6I2OC");
  }

  if (!apiKey) {
    return res.status(500).json({ error: "Chiave API non trovata. Inserisci la tua GEMINI_API_KEY nelle impostazioni del frontend (sidebar) o nel file .env del backend." });
  }

  console.log(`Resolved Gemini API Key - Length: ${apiKey.length}, Prefix: "${apiKey.substring(0, 5)}...", Suffix: "...${apiKey.substring(apiKey.length - 5)}"`);

  try {
    if (!base64Image) {
      const fileBuffer = fs.readFileSync(filePath);
      base64Data = fileBuffer.toString("base64");
    }

    let peopleInstruction = "";
    if (detectedPeople && detectedPeople.length > 0) {
      peopleInstruction = `\n- Le seguenti persone sono state riconosciute nella foto: ${detectedPeople.join(", ")}. Devi ASSOLUTAMENTE utilizzare questi NOMI SPECIFICI nei campi "title" e "description" invece di usare termini generici (es. usa "${detectedPeople.join(" e ")}" invece di "padre e figlio" o "madre e figlio" o "donna e bambino", etc.).`;
    }

    let globalTagsInstruction = "";
    if (globalTags && globalTags.length > 0) {
      globalTagsInstruction = `\n- L'utente ha fornito il seguente CONTESTO GLOBALE per questa foto: "${globalTags.join(", ")}". Devi ASSOLUTAMENTE usare questo contesto per identificare il luogo, l'evento o la situazione. Inoltre, aggiungi SEMPRE esattamente questi tag ("${globalTags.join('", "')}") all'interno dell'array "suggestedKeywords".`;
    }

    const prompt = `Analyze this photo. Return a JSON object with the following fields:
- "title": A short, descriptive title (e.g. "Mattia e Samuele davanti al Partenone").
- "description": A rich, natural description of the image content, context, and elements (e.g. for search indexing).
- "landmarks": An array of recognized landmarks or monuments.
- "objects": An array of recognized objects.
- "events": An array of activities or events (e.g. sunset, panorama, street photography).
- "weather": Meteorological conditions (e.g. sereno, nuvoloso).
- "predominantColors": Array of 3-4 main colors.
- "photoType": Type of photo (e.g. ritratto, paesaggio, architettura).
- "suggestedKeywords": An array of descriptive keywords.

Guidelines:
- Return ONLY valid JSON, no markdown formatting blocks.
- Match this travel database/context if applicable: ${JSON.stringify(landmarksDb || {})}
- Language: Italian.${peopleInstruction}${globalTagsInstruction}

JSON structure example:
{
  "title": "...",
  "description": "...",
  "landmarks": ["..."],
  "objects": ["..."],
  "events": ["..."],
  "weather": "...",
  "predominantColors": ["..."],
  "photoType": "...",
  "suggestedKeywords": ["..."]
}`;

    const response = await httpsPost(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
      JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Data
                }
              }
            ]
          }
        ]
      })
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error: ${errText}`);
    }

    const data = await response.json();
    let resultText = data.candidates[0].content.parts[0].text;
    
    // Clean up markdown block if present
    if (resultText.includes("```")) {
      resultText = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
    }
    
    const analysis = JSON.parse(resultText);

    res.json({ success: true, analysis });
  } catch (error) {
    console.error("Error during Gemini analysis:", error);
    res.status(500).json({ error: error.message });
  }
});

const TRAINED_PEOPLE_FILE = path.join(__dirname, "trained_people.json");

// Endpoint to get trained people database from disk
app.get("/api/trained-people", (req, res) => {
  if (fs.existsSync(TRAINED_PEOPLE_FILE)) {
    try {
      const data = fs.readFileSync(TRAINED_PEOPLE_FILE, "utf8");
      return res.json(JSON.parse(data));
    } catch (err) {
      console.error("Error reading trained_people.json:", err);
      return res.status(500).json({ error: "Failed to read trained people database" });
    }
  }
  
  // Return default starting list if file doesn't exist
  res.json([
    { name: 'Mattia', photos: [], descriptors: [] },
    { name: 'Tiziana', photos: [], descriptors: [] },
    { name: 'Samuele', photos: [], descriptors: [] }
  ]);
});

// Endpoint to save trained people database to disk
app.post("/api/trained-people", (req, res) => {
  const { peopleList } = req.body;
  if (!peopleList || !Array.isArray(peopleList)) {
    return res.status(400).json({ error: "peopleList is required and must be an array" });
  }

  try {
    fs.writeFileSync(TRAINED_PEOPLE_FILE, JSON.stringify(peopleList, null, 2), "utf8");
    res.json({ success: true, message: "Trained people database saved to disk successfully." });
  } catch (err) {
    console.error("Error writing trained_people.json:", err);
    res.status(500).json({ error: "Failed to write trained people database to disk" });
  }
});

// Endpoint to trigger a Git commit and push for the trained_people.json
app.post("/api/sync-github", (req, res) => {
  // We execute git from the root folder of the project
  const repoRoot = path.join(__dirname, "..");
  const cmd = `cd "${repoRoot}" && git add backend/trained_people.json && git commit -m "Auto-sync trained faces from Photo Tag Pro" && git push`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      // If there are no changes to commit, git commit returns an error (exit code 1).
      // We should check if it's just "nothing to commit"
      if (stdout.includes("nothing to commit") || stderr.includes("nothing to commit")) {
        return res.json({ success: true, message: "Tutto già sincronizzato! Nessuna modifica ai volti." });
      }
      console.error(`Error syncing to GitHub: ${error.message}`);
      return res.status(500).json({ error: "Errore durante la sincronizzazione con GitHub", details: stderr || error.message });
    }
    res.json({ success: true, message: "Volti sincronizzati con successo su GitHub!" });
  });
});

// Serve static frontend files in production
const frontendBuildPath = path.join(__dirname, "public");
app.use(express.static(frontendBuildPath));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  const indexFile = path.join(frontendBuildPath, "index.html");
  if (fs.existsSync(indexFile)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(indexFile);
  } else {
    res.status(404).send("Frontend not built. Please run npm run build in frontend directory.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PhotoArchivist AI server running on http://localhost:${PORT}`);
});
