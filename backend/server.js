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
import { Jimp } from "jimp";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");
try {
  process.chdir(repoRoot);
} catch (e) {}

const userDataDir = process.env.USER_DATA_PATH || repoRoot;
const TRAINED_PEOPLE_FILE = path.join(userDataDir, "trained_people.json");
const defaultTrainedPeople = path.join(__dirname, "trained_people.json");

if (!fs.existsSync(TRAINED_PEOPLE_FILE) && fs.existsSync(defaultTrainedPeople)) {
  try {
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    fs.copyFileSync(defaultTrainedPeople, TRAINED_PEOPLE_FILE);
  } catch (e) {
    console.error("Could not initialize trained_people.json in userData:", e);
  }
}

if (fs.existsSync(path.join(userDataDir, ".env"))) {
  dotenv.config({ path: path.join(userDataDir, ".env") });
} else if (fs.existsSync(path.join(repoRoot, ".env"))) {
  dotenv.config({ path: path.join(repoRoot, ".env") });
}

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

  // 1. Gather ONLY real confirmed person names (NEVER guess from repeated words, which deletes common words like 'bambino')
  const namesToCheck = new Set(
    (knownNames && knownNames.length > 0)
      ? knownNames.map(n => n && n.trim().replace(/\s*\[[MFB]\]/i, "")).filter(Boolean)
      : []
  );

  // Read registered names from trained_people.json if available
  try {
    const tpPath = TRAINED_PEOPLE_FILE;
    if (fs.existsSync(tpPath)) {
      const list = JSON.parse(fs.readFileSync(tpPath, "utf8"));
      if (Array.isArray(list)) {
        list.forEach(p => {
          if (p.name) namesToCheck.add(p.name.trim().replace(/\s*\[[MFB]\]/i, ""));
        });
      }
    }
  } catch (e) {}

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
        // Strip generic subject from rest if present (e.g. "Giovane gamer" -> "gamer")
        const genericRest = rest.replace(/^(?:Un |Una |Il |La )?(?:giovane|ragazzo|ragazza|bambino|bambina|persona|uomo|donna)\s+/i, "");
        if (genericRest !== rest) {
          s = `${cleanPrefix} ${genericRest}`;
        } else {
          s = `${cleanPrefix} ${rest.charAt(0).toLowerCase() + rest.slice(1)}`;
        }
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

  // 8. Fix common Italian grammar artifacts produced by local AI translation
  // Replace orphan articles before verbs (e.g. "Il indossa..." -> "Indossa...", "Il è..." -> "È...")
  s = s.replace(/\b([I|i]l|[L|l]a|[L|l]o|[I|i]|[G|g]li|[L|l]e)\s+(indossa|porta|guarda|è|ha|siede|sta|sembra|gioca|appare|trova)\b/g, (match, art, verb) => {
    return art[0] === art[0].toUpperCase() ? verb.charAt(0).toUpperCase() + verb.slice(1) : verb;
  });
  // Replace orphan "Il in..." -> "In..."
  s = s.replace(/\b([I|i]l|[L|l]a|[L|l]o)\s+(in|su|a|con|durante)\b/g, (match, art, prep) => {
    return art[0] === art[0].toUpperCase() ? prep.charAt(0).toUpperCase() + prep.slice(1) : prep;
  });
  // Replace "Nome e un bambino" -> "Nome è un bambino"
  s = s.replace(/\b([A-ZÀ-ÿa-z0-9_-]+)\s+e\s+(un|una|uno)\b/g, "$1 è $2");
  // Replace English calque "attentivo" -> "attento"
  s = s.replace(/\battentiv([oaie])\b/gi, "attent$1");
  // Clean chains of " e con " -> ", con "
  s = s.replace(/\s+e\s+con\s+/gi, ", con ");

  return s;
}

// Cache helper functions
const activeResizeJobs = new Map();

function getCachePath(filePath, size) {
  const hash = crypto.createHash("md5").update(filePath).digest("hex");
  const cacheBase = userDataDir || process.cwd();
  const cacheDir = path.join(cacheBase, ".cache", size);
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
    if (process.platform === "darwin") {
      exec(`sips -Z ${maxDim} "${srcPath}" --out "${destPath}"`, (err) => {
        activeResizeJobs.delete(key);
        if (!err && fs.existsSync(destPath)) {
          return resolve();
        }
        // Fallback to Jimp if sips fails
        Jimp.read(srcPath)
          .then(img => {
            img.scaleToFit({ w: maxDim, h: maxDim });
            return img.write(destPath);
          })
          .then(() => resolve())
          .catch(reject);
      });
    } else {
      // Windows / Linux: cross-platform image resizing via Jimp
      Jimp.read(srcPath)
        .then(img => {
          img.scaleToFit({ w: maxDim, h: maxDim });
          return img.write(destPath);
        })
        .then(() => {
          activeResizeJobs.delete(key);
          resolve();
        })
        .catch(err => {
          activeResizeJobs.delete(key);
          reject(err);
        });
    }
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
  if (process.platform === "win32") {
    const psCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Seleziona la cartella con le foto:'; if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ Write-Output $f.SelectedPath }"`;
    exec(psCmd, (err, stdout, stderr) => {
      if (err) {
        console.error("powershell folder dialog error:", stderr);
        return res.status(500).json({ error: "Folder selection failed or cancelled" });
      }
      const selectedPath = stdout.trim();
      if (selectedPath) {
        res.json({ success: true, path: selectedPath });
      } else {
        res.status(400).json({ error: "No folder selected" });
      }
    });
  } else {
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
  }
});

// Endpoint to import a local model directory (.gguf / Modelfile) directly into Ollama
app.post("/api/import-local-model", async (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.status(400).json({ error: "Percorso cartella non valido o inesistente." });
  }

  try {
    const files = fs.readdirSync(folderPath);
    let modelfilePath = path.join(folderPath, "Modelfile");
    let modelName = "llava:latest";

    // Ensure Modelfile includes both the base model and vision projector if present
    const ggufFiles = files.filter(f => f.toLowerCase().endsWith(".gguf"));
    const mainModel = ggufFiles.find(f => !f.toLowerCase().includes("mmproj") && !f.toLowerCase().includes("projector"));
    const projector = ggufFiles.find(f => f.toLowerCase().includes("mmproj") || f.toLowerCase().includes("projector"));

    if (mainModel && projector) {
      const mfContent = `FROM ./${mainModel}\nFROM ./${projector}\nPARAMETER temperature 0.2\n`;
      fs.writeFileSync(modelfilePath, mfContent, "utf8");
    } else if (!fs.existsSync(modelfilePath)) {
      if (ggufFiles.length === 0) {
        return res.status(400).json({ error: "Nessun file .gguf o Modelfile trovato nella cartella." });
      }
      const mfContent = `FROM ./${mainModel || ggufFiles[0]}\nPARAMETER temperature 0.2\n`;
      fs.writeFileSync(modelfilePath, mfContent, "utf8");
    }

    if (files.some(f => /llava/i.test(f))) {
      modelName = "llava:latest";
    } else {
      modelName = path.basename(folderPath).toLowerCase().replace(/[^a-z0-9_-]/g, "") || "local-model";
    }

    const cmd = `ollama create ${modelName} -f "${modelfilePath}"`;
    exec(cmd, { cwd: folderPath }, (err, stdout, stderr) => {
      if (err) {
        console.error("ollama create error:", stderr || err.message);
        return res.status(500).json({ error: `Errore durante il caricamento del modello in Ollama: ${stderr || err.message}. Assicurati che Ollama sia in esecuzione.` });
      }
      res.json({
        success: true,
        modelName,
        message: `Modello ${modelName} caricato con successo!`
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Endpoint to check the status of all 3 AI providers
app.post("/api/check-providers", async (req, res) => {
  const { apiKey, ollamaUrl, customCloudKey, customCloudProvider } = req.body;

  // 1. Check Gemini
  let cleanKey = (apiKey || "").trim();
  if (!cleanKey && req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    cleanKey = parts.length === 2 && parts[0] === "Bearer" ? parts[1].trim() : req.headers.authorization.trim();
  }
  if (!cleanKey) cleanKey = (process.env.GEMINI_API_KEY || "").trim();
  const geminiConnected = cleanKey.length >= 30;

  // 2. Check Ollama
  let ollamaConnected = false;
  let ollamaModels = [];
  const targetOllamaUrl = (ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const ollamaRes = await fetch(`${targetOllamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (ollamaRes.ok) {
      const data = await ollamaRes.json();
      ollamaConnected = true;
      ollamaModels = (data.models || []).map(m => m.name);
    }
  } catch (err) {
    ollamaConnected = false;
  }

  // 3. Check Custom Cloud Providers (OpenAI, Claude, Groq, OpenRouter)
  let cloudKey = (customCloudKey || "").trim();
  const currentCloud = customCloudProvider || "openai";
  let customCloudConnected = false;
  if (cloudKey) {
    if (currentCloud === "openai" && (cloudKey.startsWith("sk-") || cloudKey.length >= 20)) customCloudConnected = true;
    else if (currentCloud === "groq" && (cloudKey.startsWith("gsk_") || cloudKey.length >= 20)) customCloudConnected = true;
    else if (currentCloud === "claude" && (cloudKey.startsWith("sk-ant-") || cloudKey.length >= 20)) customCloudConnected = true;
    else if (currentCloud === "openrouter" && cloudKey.length >= 20) customCloudConnected = true;
    else if (cloudKey.length >= 10) customCloudConnected = true;
  }

  res.json({
    gemini: { connected: geminiConnected },
    ollama: { connected: ollamaConnected, models: ollamaModels, url: targetOllamaUrl },
    customCloud: { connected: customCloudConnected, provider: currentCloud }
  });
});

// Dynamic Ollama pull status tracking
let currentPullStatus = {
  active: false,
  model: "",
  status: "idle",
  completed: 0,
  total: 0,
  percent: 0,
  error: null
};

app.get("/api/pull-status", async (req, res) => {
  let installedModels = [];
  try {
    const oRes = await fetch("http://localhost:11434/api/tags");
    if (oRes.ok) {
      const data = await oRes.json();
      installedModels = (data.models || []).map(m => ({
        name: m.name,
        size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : "N/D"
      }));
    }
  } catch (e) {}

  res.json({
    ...currentPullStatus,
    installedModels
  });
});

app.post("/api/pull-model", async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "Nome modello obbligatorio" });
  if (currentPullStatus.active) {
    return res.json({ message: "Download già in corso", status: currentPullStatus });
  }

  currentPullStatus = {
    active: true,
    model,
    status: "Inizializzazione...",
    completed: 0,
    total: 0,
    percent: 0,
    error: null
  };

  res.json({ success: true, message: `Avviato download di ${model}` });

  // Stream in background from Ollama
  (async () => {
    try {
      const response = await fetch("http://localhost:11434/api/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, stream: true })
      });

      if (!response.ok) {
        currentPullStatus.active = false;
        currentPullStatus.status = "error";
        currentPullStatus.error = `Errore HTTP ${response.status}`;
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            currentPullStatus.status = data.status || "downloading";
            if (data.total && data.completed) {
              currentPullStatus.total = data.total;
              currentPullStatus.completed = data.completed;
              currentPullStatus.percent = Math.round((data.completed / data.total) * 100);
            }
          } catch (err) {}
        }
      }
      currentPullStatus.active = false;
      currentPullStatus.status = "success";
      currentPullStatus.percent = 100;
    } catch (err) {
      currentPullStatus.active = false;
      currentPullStatus.status = "error";
      currentPullStatus.error = err.message;
    }
  })();
});

// Cache in memoria per i modelli gratuiti OpenRouter
let cachedOpenRouterFreeModels = null;
let lastOpenRouterFetch = 0;

// Endpoint per scoprire dinamicamente i modelli Vision gratuiti e attivi su OpenRouter
app.get("/api/openrouter-free-models", async (req, res) => {
  const now = Date.now();
  if (cachedOpenRouterFreeModels && (now - lastOpenRouterFetch < 3600000)) {
    return res.json({ success: true, models: cachedOpenRouterFreeModels });
  }

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        "HTTP-Referer": "https://phototagpro.app",
        "X-Title": "Photo Tag Pro"
      }
    });
    if (resp.ok) {
      const data = await resp.json();
      const freeModels = (data.data || []).filter(m => {
        const id = m.id || "";
        if (!id.includes(":free")) return false;
        const mod = m.architecture?.modality || "";
        const inputs = m.input_modalities || [];
        return mod.includes("image") || mod.includes("multimodal") || inputs.includes("image");
      }).map(m => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length
      }));

      if (freeModels.length > 0) {
        cachedOpenRouterFreeModels = freeModels;
        lastOpenRouterFetch = now;
        return res.json({ success: true, models: freeModels });
      }
    }
  } catch (err) {
    console.warn("Could not fetch OpenRouter models online:", err.message);
  }

  // Fallback defaults stabili
  const fallback = [
    { id: "nvidia/nemotron-3.5-super-vl:free", name: "NVIDIA: Nemotron 3.5 Super VL (Consigliato)" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "NVIDIA: Nemotron 3 Nano Omni" },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots Studio: Dots3-Note Preview" }
  ];
  return res.json({ success: true, models: fallback });
});

// Endpoint to run AI analysis (supports Gemini Cloud, Ollama Local, and Offline Local)
app.post("/api/analyze-gemini", async (req, res) => {
  const { filePath, base64Image, customPrompt, landmarksDb, detectedPeople, globalTags, customInstruction, provider, ollamaUrl, ollamaModel, localPath } = req.body;
  const currentProvider = provider || "gemini";
  
  let base64Data = "";
  if (base64Image) {
    base64Data = base64Image;
  } else if (filePath && fs.existsSync(filePath)) {
    try {
      // Create an optimized 672px version for fast AI vision inference (reduces CPU encoding time by ~50%)
      const aiThumbPath = getCachePath(filePath, "ai_vision");
      if (!fs.existsSync(aiThumbPath)) {
        await generateResizedImage(filePath, aiThumbPath, 672);
      }
      const fileBuffer = fs.readFileSync(aiThumbPath);
      base64Data = fileBuffer.toString("base64");
    } catch (resizeErr) {
      console.warn("Fast resize with sips failed, using original file:", resizeErr.message);
      const fileBuffer = fs.readFileSync(filePath);
      base64Data = fileBuffer.toString("base64");
    }
  } else {
    return res.status(400).json({ error: "Valid file path or base64 image data is required" });
  }

  let peopleInstruction = "";
  const uniquePeople = [...new Set((detectedPeople || []).map(p => p.trim()).filter(Boolean))];
  if (uniquePeople.length > 0) {
    peopleInstruction = `\n- Persone presenti nella foto: ${uniquePeople.join(", ")}.
REGOLE FONDAMENTALI ED INDEROGABILI SUI NOMI:
1. Integra questi NOMI SPECIFICI direttamente come soggetti naturali della frase (es. "Tiziana gamer sul divano" o "Tiziana con il simulatore di guida").
2. DIVIETO ASSOLUTO DI METTERE TRATTINI O PREFISSI SEPARATI: NON scrivere MAI "Nome - Frase" (es. VIETATO "Tiziana - Giovane gamer"), ma integra il nome fluidamente (es. "Tiziana gamer in casa").
3. Sostituisci parole generiche come "ragazzo", "ragazza", "giovane", "bambino", "persona", "uomo", "donna" direttamente con il nome della persona presente.
4. DIVIETO ASSOLUTO DI DUPLICAZIONE DEI NOMI: Ciascun nome di persona deve comparire AL MASSIMO UNA SOLA VOLTA sia nel "title" che nella "description".
5. Non usare mai tag [M], [F], [B] nel testo finale.`;
  }

  let globalTagsInstruction = "";
  if (globalTags && globalTags.length > 0) {
    globalTagsInstruction = `\n- L'utente ha fornito il seguente CONTESTO GLOBALE per questa foto: "${globalTags.join(", ")}". Devi ASSOLUTAMENTE usare questo contesto per identificare il luogo, l'evento o la situazione. Inoltre, aggiungi SEMPRE esattamente questi tag ("${globalTags.join('", "')}") all'interno dell'array "suggestedKeywords".`;
  }

  let customInstructionBlock = "";
  if (customInstruction && customInstruction.trim()) {
    customInstructionBlock = `\n- ISTRUZIONE SPECIFICA DELL'UTENTE (priorità massima): ${customInstruction.trim()}\n  Utilizza queste informazioni per rendere titolo e descrizione il più precisi e contestualizzati possibile.`;
  }

  // Helper to build universal vision prompt for cloud providers
  const universalPrompt = `Analyze this photo with high precision and objectivity. Return a JSON object representing STRICTLY what is visually visible in the image.

CRITICAL RULES:
1. ONLY DESCRIBE ACTUAL VISUAL CONTENT:
   - If the photo shows food (e.g. meat, steak, dish, dessert), the title and description MUST describe the food!
   - If the photo shows an injury or anatomical detail (e.g. bruised leg, skin hematoma, arm), describe the factual condition!
   - If the photo shows a child playing or doing sport (e.g. karate, racing simulator), describe that specific activity!
   - NEVER hallucinate people or famous monuments (like Colosseum or Parthenon) unless they are genuinely present and recognizable!
2. Return a JSON object with the following fields:
- "title": A short, factual and descriptive title in Italian strictly representing the real subject (e.g. "Gamba con livido", "Bistecca cruda", "Bambino con simulatore di guida").
- "description": A rich, natural description of the genuine image content in Italian.
- "landmarks": An array of genuine landmarks recognized (empty [] if none).
- "objects": An array of recognized objects and elements.
- "events": Type of activity or scene in Italian (e.g. cucina, sport, gioco, ritratto, natura).
- "weather": Lighting or environment conditions in Italian.
- "predominantColors": Array of 3-4 main colors.
- "photoType": Type of photo in Italian (e.g. cibo, sport, ritratto, paesaggio, dettaglio).
- "suggestedKeywords": Array of descriptive Italian keywords.

Guidelines:
- Return ONLY valid JSON, no markdown formatting blocks.
- Match this travel database/context if applicable: ${JSON.stringify(landmarksDb || {})}
- Language: Italian.${peopleInstruction}${globalTagsInstruction}${customInstructionBlock}

JSON structure:
{
  "title": "...",
  "description": "...",
  "landmarks": [],
  "objects": [],
  "events": "...",
  "weather": "...",
  "predominantColors": [],
  "photoType": "...",
  "suggestedKeywords": []
}`;

  // --- PROVIDER: OPENAI / GROQ / OPENROUTER (COMPATIBILE OPENAI API) ---
  if (currentProvider === "openai" || currentProvider === "groq" || currentProvider === "openrouter") {
    let cloudApiKey = (req.body.customCloudKey || req.body.apiKey || "").trim();
    if (!cloudApiKey && req.headers.authorization) {
      cloudApiKey = req.headers.authorization.replace(/^Bearer\s+/i, "").trim();
    }
    if (!cloudApiKey) {
      if (currentProvider === "openai") cloudApiKey = (process.env.OPENAI_API_KEY || "").trim();
      else if (currentProvider === "groq") cloudApiKey = (process.env.GROQ_API_KEY || "").trim();
      else if (currentProvider === "openrouter") cloudApiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    }

    if (!cloudApiKey) {
      return res.status(400).json({ error: `Chiave API per ${currentProvider.toUpperCase()} mancante. Inseriscila nella barra laterale.` });
    }

    let endpointUrl = "https://api.openai.com/v1/chat/completions";
    let modelToUse = req.body.cloudModel || "gpt-4o-mini";
    let authHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cloudApiKey}`
    };

    if (currentProvider === "groq") {
      endpointUrl = "https://api.groq.com/openai/v1/chat/completions";
      modelToUse = (req.body.cloudModel || "llama-3.2-11b-vision-preview").trim();
    } else if (currentProvider === "openrouter") {
      endpointUrl = "https://openrouter.ai/api/v1/chat/completions";
      authHeaders["HTTP-Referer"] = "https://phototagpro.app";
      authHeaders["X-Title"] = "Photo Tag Pro";
      let requestedModel = (req.body.cloudModel || "").trim();
      // Se non specificato o se contiene modelli deprecati / con pool Google saturi
      if (!requestedModel || requestedModel.includes("meta-llama/llama-3.2-11b-vision-instruct:free") || requestedModel.includes("google/gemma-4")) {
        modelToUse = "nvidia/nemotron-3.5-super-vl:free";
      } else {
        modelToUse = requestedModel;
      }
    }

    try {
      const requestPayload = {
        model: modelToUse,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: universalPrompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Data}` } }
            ]
          }
        ],
        max_tokens: 3000,
        temperature: 0.2
      };

      if (currentProvider === "openai" || currentProvider === "groq") {
        requestPayload.response_format = { type: "json_object" };
      }

      const resp = await fetch(endpointUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(requestPayload)
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error?.message || JSON.stringify(data));
      }

      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error(data.error?.message || `Nessuna risposta ricevuta dal provider (${JSON.stringify(data)})`);
      }

      let rawContent = (choice.message?.content || choice.text || "").trim();
      if (!rawContent && choice.message?.reasoning) {
        rawContent = choice.message.reasoning.trim();
      }

      if (!rawContent) {
        if (choice.finish_reason === "error" || choice.error) {
          throw new Error(choice.error?.message || `Errore interno del fornitore OpenRouter (finish_reason: error)`);
        }
        throw new Error(`Risposta vuota dal modello (finish_reason: ${choice.finish_reason || 'sconosciuto'}).`);
      }

      let cleanText = rawContent.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
      let parsedJson = null;

      // Tentativo 1: Parse JSON standard
      try {
        parsedJson = JSON.parse(cleanText);
      } catch (parseErr) {
        // Tentativo 2: Estrazione oggetto JSON con regex
        const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsedJson = JSON.parse(jsonMatch[0]);
          } catch (e2) {}
        }

        // Tentativo 3: Riparazione JSON troncato da limiti token o interruzioni
        if (!parsedJson) {
          try {
            let repaired = cleanText.trim();
            const startBrace = repaired.indexOf('{');
            if (startBrace !== -1) {
              repaired = repaired.substring(startBrace);
            }
            if (!repaired.endsWith('}')) {
              // Chiudi virgoletta se numero dispari
              const quotesCount = (repaired.match(/(?<!\\)"/g) || []).length;
              if (quotesCount % 2 !== 0) repaired += '"';
              
              // Chiudi eventuali array aperti
              const openBrackets = (repaired.match(/\[/g) || []).length;
              const closeBrackets = (repaired.match(/\]/g) || []).length;
              for (let b = 0; b < openBrackets - closeBrackets; b++) repaired += ']';

              repaired += '}';
            }
            parsedJson = JSON.parse(repaired);
          } catch (eRep) {}
        }

        // Tentativo 4: Estrazione regex d'emergenza se title o description sono presenti
        if (!parsedJson) {
          const titleM = cleanText.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
          const descM = cleanText.match(/"description"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
          if (titleM || descM) {
            parsedJson = {
              title: titleM ? titleM[1] : "Senza titolo",
              description: descM ? descM[1] : "",
              landmarks: [],
              objects: [],
              events: "",
              weather: "",
              predominantColors: [],
              photoType: "Fotografia",
              suggestedKeywords: []
            };
          }
        }

        if (!parsedJson) {
          throw new Error(`Risposta non in formato JSON da ${currentProvider}: ${rawContent.slice(0, 150)}`);
        }
      }

      if (parsedJson.title) parsedJson.title = cleanDuplicateNames(parsedJson.title, uniquePeople);
      if (parsedJson.description) parsedJson.description = cleanDuplicateNames(parsedJson.description, uniquePeople);

      return res.json({ success: true, analysis: parsedJson, provider: currentProvider, model: modelToUse });
    } catch (apiErr) {
      console.error(`Errore API ${currentProvider}:`, apiErr);
      return res.status(500).json({ error: `Errore ${currentProvider.toUpperCase()}: ${apiErr.message}` });
    }
  }

  // --- PROVIDER: ANTHROPIC CLAUDE ---
  if (currentProvider === "claude") {
    let cloudApiKey = (req.body.customCloudKey || req.body.apiKey || "").trim();
    if (!cloudApiKey && req.headers.authorization) {
      cloudApiKey = req.headers.authorization.replace(/^Bearer\s+/i, "").trim();
    }
    if (!cloudApiKey) cloudApiKey = (process.env.ANTHROPIC_API_KEY || "").trim();

    if (!cloudApiKey) {
      return res.status(400).json({ error: "Chiave API Anthropic Claude mancante. Inseriscila nella barra laterale." });
    }

    const modelToUse = req.body.cloudModel || "claude-3-5-haiku-20241022";

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": cloudApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: modelToUse,
          max_tokens: 1000,
          temperature: 0.2,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: base64Data
                  }
                },
                {
                  type: "text",
                  text: universalPrompt + "\n\nCRITICAL: Respond ONLY with a valid JSON object matching the requested schema. No markdown formatting."
                }
              ]
            }
          ]
        })
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error?.message || JSON.stringify(data));
      }

      const textContent = data.content?.[0]?.text || "";
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Risposta Claude non valida o priva di JSON");
      let parsedJson = JSON.parse(jsonMatch[0]);

      if (parsedJson.title) parsedJson.title = cleanDuplicateNames(parsedJson.title, uniquePeople);
      if (parsedJson.description) parsedJson.description = cleanDuplicateNames(parsedJson.description, uniquePeople);

      return res.json({ success: true, analysis: parsedJson, provider: "claude", model: modelToUse });
    } catch (apiErr) {
      console.error("Errore API Claude:", apiErr);
      return res.status(500).json({ error: `Errore Anthropic Claude: ${apiErr.message}` });
    }
  }

  // --- PROVIDER 2: OLLAMA VISION (LOCALE OFFLINE O ENSEMBLE COOPERATIVO) ---
  if (currentProvider === "ollama") {
    const targetOllamaUrl = (ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
    let rawModelsToRun = [];
    if (Array.isArray(req.body.ollamaModels) && req.body.ollamaModels.length > 0) {
      rawModelsToRun = req.body.ollamaModels;
    } else if (req.body.ollamaModel) {
      rawModelsToRun = [req.body.ollamaModel];
    } else {
      rawModelsToRun = ["llava:latest"];
    }

    // Check which models actually exist locally in Ollama to skip models that are still downloading
    let installedModels = [];
    try {
      const tagsRes = await fetch(`${targetOllamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (tagsRes.ok) {
        const tagsData = await tagsRes.json();
        installedModels = (tagsData.models || []).map(m => m.name || m.model);
      }
    } catch (tErr) {}

    const modelsToRun = rawModelsToRun.filter(m => {
      if (installedModels.length === 0) return true;
      return installedModels.some(im => im === m || im.startsWith(m.split(':')[0]));
    });

    if (modelsToRun.length === 0 && installedModels.length > 0) {
      modelsToRun.push(installedModels[0]);
    }

    const runSingleModel = async (targetModel) => {
      const promptOllama = `Sei un esperto per l'analisi visiva e il tagging automatico di fotografie in lingua italiana.
Analizza accuratamente l'immagine fornita e genera un oggetto JSON valido.

REGOLE TASSATIVE ED INDEROGABILI:
1. DESCRIVI CON MASSIMA PRECISIONE SOLO IL SOGGETTO REALE VISIBILE:
   - Se c'è del cibo (es. carne, bistecca, pasta, dolce), il titolo deve riflettere esattamente il cibo visibile (es. "Bistecca cruda", "Piatto di pasta").
   - Se c'è una parte del corpo o condizione fisica (es. gamba con livido, ematoma, braccio, mano, pelle), descrivi la realtà oggettiva (es. "Livido sulla gamba", "Gamba con vistoso ematoma").
   - Se c'è uno sport o attività (es. karate, arti marziali, corsa, gioco), il titolo deve descrivere l'attività (es. "Bambino che fa karate", "Allenamento sportivo").
   - Se c'è un videogioco, simulatore di guida, volante o gaming, descrivi la situazione reale (es. "Sessione al simulatore di guida").
   - Se c'è un paesaggio o natura, descrivi l'ambiente (es. "Tramonto sul mare", "Sentiero di montagna").
   - DIVIETO ASSOLUTO DI ALLUCINAZIONE: NON inventare MAI persone o monumenti celebri se non sono visibili!
   - DIVIETO ASSOLUTO DI COPIARE PLACEHOLDER: NON scrivere mai nel JSON frasi generiche o etichette come "titolo descrittivo" o "descrizione naturale".
2. Struttura del JSON da compilare con i contenuti REALI dell'immagine:
{
  "title": "...",
  "description": "...",
  "landmarks": [],
  "objects": [],
  "events": "...",
  "weather": "...",
  "predominantColors": [],
  "photoType": "...",
  "suggestedKeywords": []
}
3. Rispondi ESCLUSIVAMENTE in lingua italiana con JSON valido.${peopleInstruction}${globalTagsInstruction}${customInstructionBlock}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 180s safety timeout for CPU inference

      let ollamaRes;
      try {
        ollamaRes = await fetch(`${targetOllamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: targetModel,
            prompt: promptOllama,
            images: [base64Data],
            stream: false,
            format: "json",
            options: {
              temperature: 0.2,
              num_predict: 250,
              num_thread: 8
            }
          })
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!ollamaRes.ok) {
        throw new Error(`Errore Ollama (${ollamaRes.status}) su ${targetModel}`);
      }

      const ollamaData = await ollamaRes.json();
      let rawResponse = (ollamaData.response || "").trim();
      rawResponse = rawResponse.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

      let parsed = null;
      try {
        parsed = JSON.parse(rawResponse);
      } catch (parseErr) {
        // Attempt repairing unclosed quotes or missing closing braces from num_predict limit
        try {
          let repaired = rawResponse.trim();
          if (!repaired.endsWith('}')) {
            if ((repaired.match(/"/g) || []).length % 2 !== 0) repaired += '"';
            repaired += '}';
          }
          parsed = JSON.parse(repaired);
        } catch (eRep) {}

        if (!parsed) {
          const match = rawResponse.match(/\{[\s\S]*\}/);
          if (match) {
            try { parsed = JSON.parse(match[0]); } catch (e2) {}
          }
        }
        if (!parsed) {
          const titleM = rawResponse.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
          const descM = rawResponse.match(/"description"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
          parsed = {
            title: titleM ? titleM[1] : (uniquePeople.length > 0 ? `Scatto con ${uniquePeople.join(', ')}` : "Fotografia"),
            description: descM ? descM[1] : (uniquePeople.length > 0 ? `Foto raffigurante ${uniquePeople.join(' e ')}.` : "Fotografia scattata sul posto."),
            landmarks: [],
            objects: [],
            events: uniquePeople.length > 0 ? "ritratto" : "generale",
            weather: "naturale",
            predominantColors: [],
            photoType: uniquePeople.length > 0 ? "ritratto" : "generale",
            suggestedKeywords: [...uniquePeople, ...(globalTags || [])]
          };
        }
      }
      return parsed;
    };

    try {
      const results = [];
      for (const m of modelsToRun) {
        try {
          const res = await runSingleModel(m);
          if (res) results.push({ model: m, data: res });
        } catch (mErr) {
          console.warn(`Errore durante esecuzione modello ${m}:`, mErr.message);
        }
      }

      if (results.length === 0) {
        throw new Error("Nessuno dei modelli Ollama selezionati ha risposto correttamente.");
      }

      // Prioritize capable vision models (LLaVA / LLaMA) for titles and descriptions
      const primaryResult = results.find(r => r.model.includes('llava') || r.model.includes('llama')) || results[0];

      let merged = { ...primaryResult.data };

      // Enrich with union of keywords and objects from all running models
      if (results.length > 1) {
        const allKeywords = new Set(merged.suggestedKeywords || []);
        const allObjects = new Set(merged.objects || []);
        const allLandmarks = new Set(merged.landmarks || []);

        results.forEach(r => {
          (r.data.suggestedKeywords || []).forEach(k => k && allKeywords.add(k.trim()));
          (r.data.objects || []).forEach(o => o && allObjects.add(typeof o === 'string' ? o.trim() : JSON.stringify(o)));
          (r.data.landmarks || []).forEach(l => l && allLandmarks.add(typeof l === 'string' ? l.trim() : JSON.stringify(l)));
        });

        uniquePeople.forEach(p => allKeywords.add(p));
        (globalTags || []).forEach(t => allKeywords.add(t));

        merged.suggestedKeywords = Array.from(allKeywords);
        merged.objects = Array.from(allObjects);
        merged.landmarks = Array.from(allLandmarks);
      }

      // Safeguard against hallucinated Colosseo or fake landmarks
      if (merged.title && /colosseo/i.test(merged.title) && !(merged.landmarks || []).some(l => /colosseo/i.test(l))) {
        if (merged.objects && merged.objects.length > 0) {
          merged.title = `Foto di ${merged.objects.slice(0, 2).join(' e ')}`;
        } else {
          merged.title = merged.photoType ? `Scatto di ${merged.photoType}` : "Fotografia";
        }
      }

      // Safeguard against placeholder strings copied literally by local models
      const isPlaceholder = (t) => !t || typeof t !== "string" || 
        /titolo descrittivo|fedele al soggetto|descrizione naturale|in italiano|\.\.\.|^oggetto$/i.test(t);

      if (isPlaceholder(merged.title)) {
        const validObjs = (merged.objects || []).filter(o => typeof o === 'string' && !isPlaceholder(o));
        if (validObjs.length > 0) {
          merged.title = `Foto di ${validObjs.slice(0, 2).join(' e ')}`;
        } else {
          merged.title = uniquePeople.length > 0 ? `Foto con ${uniquePeople.join(' e ')}` : "Dettaglio";
        }
      }

      if (isPlaceholder(merged.description)) {
        merged.description = uniquePeople.length > 0 
          ? `Fotografia che ritrae ${uniquePeople.join(' e ')}.`
          : `Fotografia del soggetto visibile.`;
      } else if (typeof merged.description === "string") {
        // Strip any residual prompt echo
        merged.description = merged.description
          .replace(/\s*(?:e\s+)?fornita in modo esclusivo per l['’]analisi.*$/i, "")
          .replace(/\s*fornita per l['’]analisi.*$/i, "")
          .trim();
        if (merged.description && !/[.!?]$/.test(merged.description)) {
          merged.description += ".";
        }
      }

      if (merged.title) merged.title = cleanDuplicateNames(merged.title, uniquePeople);
      if (merged.description) merged.description = cleanDuplicateNames(merged.description, uniquePeople);

      return res.json({
        success: true,
        analysis: merged,
        provider: results.length > 1 ? "ollama-ensemble" : "ollama",
        modelsUsed: results.map(r => r.model)
      });
    } catch (ollamaErr) {
      console.error("Ollama ensemble error:", ollamaErr);
      return res.status(500).json({ error: `Impossibile completare l'analisi con Ollama: ${ollamaErr.message}. Verifica che Ollama sia in esecuzione.` });
    }
  }

  // --- PROVIDER 3: GOOGLE GEMINI (CLOUD) ---
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
    return res.status(500).json({ error: "Chiave API Gemini mancante o non valida. Inserisci la tua GEMINI_API_KEY o seleziona un altro motore AI nella barra laterale." });
  }

  console.log(`Resolved Gemini API Key - Length: ${apiKey.length}, Prefix: "${apiKey.substring(0, 5)}...", Suffix: "...${apiKey.substring(apiKey.length - 5)}"`);

  try {

    const prompt = `Analyze this photo with high precision and objectivity. Return a JSON object representing STRICTLY what is visually visible in the image.

CRITICAL RULES:
1. ONLY DESCRIBE ACTUAL VISUAL CONTENT:
   - If the photo shows food (e.g. meat, steak, dish, dessert), the title and description MUST describe the food!
   - If the photo shows a child playing or doing sport (e.g. karate, soccer, playground), describe that specific activity!
   - NEVER hallucinate people or famous monuments (like Colosseum or Parthenon) unless they are genuinely present and recognizable!
2. Return a JSON object with the following fields:
- "title": A short, factual and descriptive title in Italian strictly representing the real subject (e.g. "Bistecca ai ferri", "Bambino che si allena a karate").
- "description": A rich, natural description of the genuine image content in Italian.
- "landmarks": An array of genuine landmarks recognized (empty [] if none).
- "objects": An array of recognized objects and elements.
- "events": Type of activity or scene in Italian (e.g. cucina, sport, gioco, ritratto, natura).
- "weather": Lighting or environment conditions in Italian.
- "predominantColors": Array of 3-4 main colors.
- "photoType": Type of photo in Italian (e.g. cibo, sport, ritratto, paesaggio).
- "suggestedKeywords": Array of descriptive Italian keywords.

Guidelines:
- Return ONLY valid JSON, no markdown formatting blocks.
- Match this travel database/context if applicable: ${JSON.stringify(landmarksDb || {})}
- Language: Italian.${peopleInstruction}${globalTagsInstruction}${customInstructionBlock}

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

    const response = await httpsPost(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
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
  const { title, description, instruction, provider, ollamaUrl, ollamaModel, ollamaModels } = req.body;
  const currentProvider = provider || "gemini";

  if (currentProvider === "local") {
    return res.json({
      title: title || "",
      description: `${description || ""}`.trim()
    });
  }

  if (currentProvider === "ollama") {
    const targetOllamaUrl = (ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
    const targetModel = (Array.isArray(ollamaModels) && ollamaModels.length > 0)
      ? (ollamaModels.find(m => m.includes('llava') || m.includes('llama')) || ollamaModels[0])
      : (ollamaModel || "llava:latest");
    const promptOllama = `Riscrivi il seguente titolo e descrizione seguendo questa istruzione: "${instruction}".
Testo originale:
- Titolo: "${title || ""}"
- Descrizione: "${description || ""}"

Regole fondamentali:
1. Rispondi in italiano corretto.
2. Rispondi ESCLUSIVAMENTE con un JSON valido: {"title": "...", "description": "..."}
3. Evita duplicazioni di nomi.`;

    try {
      const ollamaRes = await fetch(`${targetOllamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: targetModel,
          prompt: promptOllama,
          stream: false,
          format: "json"
        })
      });
      if (ollamaRes.ok) {
        const oData = await ollamaRes.json();
        let rawO = (oData.response || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
        const parsed = JSON.parse(rawO);
        return res.json(parsed);
      }
    } catch (e) {
      console.error("Ollama rewrite error:", e);
    }
  }

  // Provider Cloud (OpenRouter, Groq, OpenAI) per riscrittura testo
  if (currentProvider === "openrouter" || currentProvider === "openai" || currentProvider === "groq") {
    let cloudApiKey = (req.body.customCloudKey || req.body.apiKey || "").trim();
    if (!cloudApiKey && req.headers.authorization) {
      cloudApiKey = req.headers.authorization.replace(/^Bearer\s+/i, "").trim();
    }
    if (!cloudApiKey) {
      if (currentProvider === "openai") cloudApiKey = (process.env.OPENAI_API_KEY || "").trim();
      else if (currentProvider === "groq") cloudApiKey = (process.env.GROQ_API_KEY || "").trim();
      else if (currentProvider === "openrouter") cloudApiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    }

    if (cloudApiKey) {
      let endpointUrl = "https://api.openai.com/v1/chat/completions";
      let modelToUse = (req.body.cloudModel || "gpt-4o-mini").trim();
      let authHeaders = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cloudApiKey}`
      };

      if (currentProvider === "groq") {
        endpointUrl = "https://api.groq.com/openai/v1/chat/completions";
        modelToUse = (req.body.cloudModel || "llama-3.2-11b-vision-preview").trim();
      } else if (currentProvider === "openrouter") {
        endpointUrl = "https://openrouter.ai/api/v1/chat/completions";
        authHeaders["HTTP-Referer"] = "https://phototagpro.app";
        authHeaders["X-Title"] = "Photo Tag Pro";
        if (!modelToUse || modelToUse.includes("llama-3.2-11b-vision-instruct:free") || modelToUse.includes("google/gemma-4")) {
          modelToUse = "nvidia/nemotron-3.5-super-vl:free";
        }
      }

      try {
        const cloudRes = await fetch(endpointUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            model: modelToUse,
            messages: [
              {
                role: "user",
                content: `Rewrite the following title and description according to this instruction: "${instruction}".
IMPORTANT: Return ONLY a valid JSON object:
{"title": "...", "description": "..."}
Language: Italian. Keep context identical, fix grammar and gender agreements (e.g. seduta/seduto, ragazzo/ragazza).

Original Title: "${title || ""}"
Original Description: "${description || ""}"`
              }
            ],
            max_tokens: 1500,
            temperature: 0.2
          })
        });

        if (cloudRes.ok) {
          const cData = await cloudRes.json();
          const choice = cData.choices?.[0];
          let rawText = (choice?.message?.content || choice?.text || "").trim();
          if (!rawText && choice?.message?.reasoning) rawText = choice.message.reasoning.trim();
          const clean = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
          const m = clean.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            if (parsed.title) parsed.title = cleanDuplicateNames(parsed.title);
            if (parsed.description) parsed.description = cleanDuplicateNames(parsed.description);
            return res.json(parsed);
          }
        }
      } catch (cloudErr) {
        console.error("Cloud rewrite-text error:", cloudErr);
      }
    }
  }

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

    const response = await httpsPost(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
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

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Photo Tag Pro server running on http://localhost:${PORT}`);
  if (process.send) {
    process.send({ type: "SERVER_READY", port: PORT });
  }
});

const cleanup = async () => {
  try {
    await exiftool.end();
  } catch (e) {}
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
