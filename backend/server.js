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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");
try {
  process.chdir(repoRoot);
} catch (e) {}

dotenv.config({ path: path.join(repoRoot, ".env") });

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


const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Heartbeat auto-shutdown mechanism for local app environment
let lastHeartbeat = Date.now() + 45000; // Allow 45s for startup

app.post("/api/heartbeat", (req, res) => {
  lastHeartbeat = Date.now();
  res.json({ success: true });
});

/*
setInterval(() => {
  if (Date.now() - lastHeartbeat > 8000) {
    console.log("No active clients detected (heartbeat timeout). Shutting down server...");
    process.exit(0);
  }
}, 3000);
*/

// Helper function to prevent any duplicate person names in titles and descriptions
function cleanDuplicateNames(text, knownNames = []) {
  if (!text || typeof text !== "string") return text;
  let s = text.trim();

  // 1. Gather all names to enforce
  const namesToCheck = new Set(
    (knownNames && knownNames.length > 0)
      ? knownNames.map(n => n && n.trim().replace(/\s*\[[MFB]\]/i, "")).filter(Boolean)
      : []
  );

  // Automatically read all names from trained_people.json if available
  try {
    const tpPath = path.join(__dirname, "trained_people.json");
    if (fs.existsSync(tpPath)) {
      const list = JSON.parse(fs.readFileSync(tpPath, "utf8"));
      if (Array.isArray(list)) {
        list.forEach(p => {
          if (p.name) namesToCheck.add(p.name.trim().replace(/\s*\[[MFB]\]/i, ""));
        });
      }
    }
  } catch (e) {}

  // Auto-detect ANY word that appears multiple times in the text (case-insensitive)
  const words = s.match(/\b[A-ZÀ-ÿa-z0-9_-]{2,}\b/g) || [];
  const wordCounts = new Map();
  for (const w of words) {
    const lower = w.toLowerCase();
    wordCounts.set(lower, (wordCounts.get(lower) || 0) + 1);
  }

  // Common stop words to exclude from auto-detected names
  const stopWords = new Set([
    "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
    "e", "ed", "o", "od", "che", "del", "della", "dello", "dei", "degli", "delle",
    "al", "alla", "allo", "ai", "agli", "alle", "nel", "nella", "nello", "nei", "negli", "nelle",
    "sul", "sulla", "sullo", "sui", "sugli", "sulle", "dal", "dalla", "dallo", "dai", "dagli", "dalle",
    "non", "si", "ci", "vi", "ne", "mi", "ti", "ci", "vi", "si", "foto", "piazza", "via", "notturna"
  ]);

  for (const [lower, count] of wordCounts.entries()) {
    if (count > 1 && !stopWords.has(lower)) {
      const orig = words.find(w => w.toLowerCase() === lower);
      if (orig && (orig[0] === orig[0].toUpperCase() || orig.length >= 3)) {
        namesToCheck.add(orig);
      }
    }
  }

  // 2. Collapse immediate repeated words with commas, "e", "ed", "-", ":" (e.g. "Mattia, Mattia e Mattia" -> "Mattia")
  let prev;
  do {
    prev = s;
    s = s.replace(/\b([A-ZÀ-ÿa-z0-9_-]+)(?:\s*(?:,|e|ed|-|:)\s+\1)+\b/gi, "$1");
  } while (s !== prev);

  // 3. Strip artificial description prefixes like "Mattia, Samuele: Una foto notturna..." -> "Una foto notturna..."
  s = s.replace(/^[A-ZÀ-ÿa-z0-9_,\s-]+(?:e|ed)?\s+[A-ZÀ-ÿa-z0-9_-]+\s*[-:]\s*(Una foto|Un |Uno |Due |Foto|Splendida|Suggestiva|In |Vista|Panoramica|Primo piano|Immagine)/i, "$1");

  // 4. Check for prefix like "Prefix Names - Rest of sentence" or "Prefix Names: Rest of sentence"
  const prefixMatch = s.match(/^([^:-]+?)\s*[-:]\s*(.+)$/i);
  if (prefixMatch) {
    const prefix = prefixMatch[1].trim();
    const rest = prefixMatch[2].trim();
    
    const prefixWords = prefix.match(/\b[A-ZÀ-ÿa-z0-9_-]{2,}\b/g) || [];
    const restLower = rest.toLowerCase();
    
    // If every significant word in prefix is already in rest, drop the prefix entirely!
    const allInRest = prefixWords.length > 0 && prefixWords.every(w => stopWords.has(w.toLowerCase()) || restLower.includes(w.toLowerCase()));
    if (allInRest) {
      s = rest;
    } else {
      let cleanPrefix = prefix;
      for (const name of namesToCheck) {
        if (!name || name.length < 2) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const restRegex = new RegExp(`\\b${escaped}\\b`, "i");
        if (restRegex.test(rest)) {
          cleanPrefix = cleanPrefix.replace(new RegExp(`(?:\\s*(?:,|e|ed)\\s+)?\\b${escaped}\\b`, "gi"), "");
        }
      }
      cleanPrefix = cleanPrefix.replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
                               .replace(/\b(e|ed)\s*$/gi, "")
                               .trim();
      if (cleanPrefix.length > 0) {
        s = `${cleanPrefix} - ${rest}`;
      } else {
        s = rest;
      }
    }
  }

  // 5. For every name in namesToCheck, enforce strictly AT MOST 1 occurrence in the entire text
  for (const name of namesToCheck) {
    if (!name || name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "gi");
    const matches = s.match(regex);
    if (!matches || matches.length <= 1) continue;

    let seen = 0;
    const subRegex = new RegExp(`(?:\\s*(?:,|e|ed|con)\\s+)?\\b${escaped}\\b`, "gi");
    s = s.replace(subRegex, (match) => {
      seen++;
      if (seen === 1) return match;
      return "";
    });
  }

  // 6. Polish commas between two names to "e" (e.g. "Samuele, Mattia in piazza" -> "Samuele e Mattia in piazza")
  s = s.replace(/\b([A-ZÀ-ÿa-z0-9_-]+),\s+([A-ZÀ-ÿa-z0-9_-]+)\b(?!\s*,)/g, "$1 e $2");

  // 7. Polish punctuation, conjunctions, and whitespace
  s = s.replace(/\s*,\s*e\b/gi, " e")
       .replace(/\be\s+e\b/gi, "e")
       .replace(/\s*[-:]\s*[-:]\s*/g, " - ")
       .replace(/^[-:,\s]+/, "")
       .replace(/[-:,\s]+$/, "")
       .replace(/\s{2,}/g, " ")
       .trim();

  // Polish dangling prepositions at end of sentences
  s = s.replace(/\s+\b(con|e|ed|in|su|tra|fra|di|a|da)\s*([.,;!?]?)$/gi, "$2").trim();

  return s;
}

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
      return res.sendFile(cachePath, { dotfiles: "allow" }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).end();
      });
    }

    try {
      await generateResizedImage(filePath, cachePath, maxDim);
      return res.sendFile(cachePath, { dotfiles: "allow" }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).end();
      });
    } catch (err) {
      console.error(`Error generating ${cacheSizeName} for ${filePath}:`, err);
      // Fallback to sending the original file on resize error
      return res.sendFile(filePath, { dotfiles: "allow" }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).end();
      });
    }
  }

  res.sendFile(filePath, { dotfiles: "allow" }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
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
        title: cleanDuplicateNames(rawTitle),
        description: cleanDuplicateNames(rawDesc),
        keywords: cleanedKeywords,
        date: tags.DateTimeOriginal || tags.CreateDate || stats.mtime
      };
    } catch (err) {
      console.error(`Error reading metadata for ${filePath}:`, err);
    }

    res.json({
      success: true,
      metadata: existingMetadata,
      analyzed: !!(existingMetadata.keywords && existingMetadata.keywords.length > 0)
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
  const cleanTitle = cleanDuplicateNames(title);
  const cleanDesc = cleanDuplicateNames(description);

  try {
    // Write using exiftool
    // Keywords are written to both Keywords (IPTC) and Subject (XMP) for maximum compatibility with macOS Finder/Spotlight
    await exiftool.write(filePath, {
      Title: cleanTitle || null,
      ObjectName: cleanTitle || null,
      XPTitle: cleanTitle || null,
      
      Description: cleanDesc || null,
      ImageDescription: cleanDesc || null,
      "Caption-Abstract": cleanDesc || null,
      UserComment: cleanDesc || null,
      Comment: cleanDesc || null,
      XPComment: cleanDesc || null,
      
      Keywords: (keywords && keywords.length > 0) ? keywords : null,
      Subject: (keywords && keywords.length > 0) ? keywords : null,
      XPKeywords: (Array.isArray(keywords) && keywords.length > 0) ? keywords.join("; ") : null
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
    const uniquePeople = [...new Set((detectedPeople || []).map(p => p.trim()).filter(Boolean))];
    if (uniquePeople.length > 0) {
      peopleInstruction = `\n- Persone presenti nella foto: ${uniquePeople.join(", ")}.
REGOLE FONDAMENTALI ED INDEROGABILI SUI NOMI:
1. Devi ASSOLUTAMENTE utilizzare questi NOMI SPECIFICI nei campi "title" e "description".
2. DIVIETO ASSOLUTO DI DUPLICAZIONE DEI NOMI: Ciascun nome di persona deve comparire AL MASSIMO UNA SOLA VOLTA sia nel "title" che nella "description".
3. È SEVERAMENTE VIETATO scrivere frasi con nomi duplicati come "X e X" o "X e Y e X". Se una persona è già menzionata nella frase, NON citarla una seconda volta.
4. Se i nomi contengono tag come [M], [F], [B], usali SOLO per comprendere il sesso o l'età e coniugare correttamente la grammatica italiana. NON includere MAI i tag [M], [F], [B] nel testo finale generato.`;
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
    if (!data.candidates || !data.candidates[0].content) {
      return res.status(500).json({ error: "Invalid response from Gemini API" });
    }

    let textResponse = data.candidates[0].content.parts[0].text;
    textResponse = textResponse.replace(/```json/g, "").replace(/```/g, "").trim();
    
    let parsedJson = {};
    try {
      parsedJson = JSON.parse(textResponse);
    } catch (e) {
      console.error("Gemini returned invalid JSON:", textResponse);
      return res.status(500).json({ error: "Gemini returned invalid JSON format" });
    }

    if (parsedJson.title) parsedJson.title = cleanDuplicateNames(parsedJson.title, uniquePeople);
    if (parsedJson.description) parsedJson.description = cleanDuplicateNames(parsedJson.description, uniquePeople);

    res.json({ success: true, analysis: parsedJson });

  } catch (error) {
    console.error("Error during Gemini analysis:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to rewrite text (title and description) when a person is modified
app.post("/api/rewrite-text", async (req, res) => {
  const { title, description, instruction } = req.body;
  
  let apiKey = "";
  if (req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    const token = parts.length === 2 && parts[0] === "Bearer" ? parts[1] : req.headers.authorization;
    if (token && token.trim() !== "" && token.trim() !== "null" && token.trim() !== "undefined") {
      apiKey = token.trim();
    }
  }
  if (!apiKey) apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (apiKey && apiKey.startsWith("AQ.Ab8RN6I20C")) apiKey = apiKey.replace("AQ.Ab8RN6I20C", "AQ.Ab8RN6I2OC");
  
  if (!apiKey) return res.status(500).json({ error: "Chiave API mancante." });

  try {
    const prompt = `Rewrite the following title and description according to the user instruction.
IMPORTANT: Output ONLY a valid JSON object with the keys "title" and "description". Do not include any markdown blocks.
Instruction: ${instruction}
Language: Italian. Keep the rest of the context identical, just fix the grammar after applying the instruction.

REGOLE FONDAMENTALI ED INDEROGABILI SUI NOMI:
1. DIVIETO ASSOLUTO DI DUPLICAZIONE DEI NOMI: Ciascun nome di persona deve comparire AL MASSIMO UNA SOLA VOLTA nel "title" e AL MASSIMO UNA SOLA VOLTA nella "description".
2. Se un nome è già presente nel testo, NON aggiungerlo di nuovo. NON scrivere MAI frasi con nomi ripetuti come "X e X" o "Samuele e Mattia e Mattia e Mattia".
3. Riscrivi la frase in italiano naturale ed elegante, evitando qualsiasi ripetizione inutile dello stesso soggetto o congiunzioni ripetute ("e X e X").
4. Se l'istruzione o i nomi contengono tag come [M], [F], [B], usali SOLO come contesto per coniugare correttamente la grammatica italiana. NON includere MAI i tag letterali [M], [F], [B] nel testo in output.

Original Title: ${title}
Original Description: ${description}

Output format:
{
  "title": "...",
  "description": "..."
}`;

    const response = await httpsPost(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
      JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    );

    const data = await response.json();
    if (!data.candidates || !data.candidates[0].content) {
      return res.status(500).json({ error: "Invalid response from Gemini API" });
    }

    let textResponse = data.candidates[0].content.parts[0].text;
    textResponse = textResponse.replace(/```json/g, "").replace(/```/g, "").trim();
    
    let parsedJson = {};
    try {
      parsedJson = JSON.parse(textResponse);
    } catch (e) {
      return res.status(500).json({ error: "Gemini returned invalid JSON format" });
    }

    if (parsedJson.title) parsedJson.title = cleanDuplicateNames(parsedJson.title);
    if (parsedJson.description) parsedJson.description = cleanDuplicateNames(parsedJson.description);

    res.json(parsedJson);

  } catch (error) {
    console.error("Error in rewrite-text:", error);
    res.status(500).json({ error: "Error rewriting text with Gemini" });
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
  const repoRoot = path.join(__dirname, "..");
  
  // 1. Check if trained_people.json has uncommitted local changes
  exec("git status --porcelain backend/trained_people.json", { cwd: repoRoot }, (statusErr, statusOut) => {
    const hasLocalChanges = !statusErr && statusOut.trim().length > 0;
    
    if (hasLocalChanges) {
      const commitCmd = `git add backend/trained_people.json && git commit -m "Auto-sync trained faces from Photo Tag Pro" && git push`;
      exec(commitCmd, { cwd: repoRoot }, (commitErr, stdout, stderr) => {
        if (commitErr) {
          const allOut = `${stdout} ${stderr}`;
          if (allOut.includes("nothing to commit") || allOut.includes("no changes added")) {
            return res.json({ success: true, message: "I volti sono già perfettamente sincronizzati con GitHub!" });
          }
          console.error("Error syncing to GitHub:", commitErr.message, stderr);
          return res.status(500).json({ error: "Errore durante la sincronizzazione con GitHub", details: stderr || commitErr.message });
        }
        return res.json({ success: true, message: "Volti sincronizzati con successo su GitHub!" });
      });
    } else {
      // 2. No uncommitted local changes. Check if there are any unpushed commits
      exec("git log origin/main..HEAD --oneline", { cwd: repoRoot }, (logErr, logOut) => {
        const hasUnpushed = !logErr && logOut.trim().length > 0;
        if (hasUnpushed) {
          exec("git push", { cwd: repoRoot }, (pushErr, pOut, pErr) => {
            if (pushErr) {
              console.error("Error pushing to GitHub:", pushErr.message, pErr);
              return res.status(500).json({ error: "Errore durante il push su GitHub", details: pErr || pushErr.message });
            }
            return res.json({ success: true, message: "Modifiche inviate a GitHub con successo!" });
          });
        } else {
          return res.json({ success: true, message: "I volti sono già perfettamente sincronizzati con GitHub!" });
        }
      });
    }
  });
});

// Endpoint to gracefully shut down the local server
app.post("/api/shutdown", (req, res) => {
  res.json({ success: true, message: "Server spento con successo." });
  setTimeout(() => {
    process.exit(0);
  }, 400);
});

// Serve static frontend files in production
const frontendBuildPath = path.join(__dirname, "public");
app.use(express.static(frontendBuildPath, { index: false }));
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
  console.log(`Photo Tag Pro server running on http://localhost:${PORT}`);
});
