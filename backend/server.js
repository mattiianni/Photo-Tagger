import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { exiftool } from "exiftool-vendored";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Endpoint to stream local images to browser
app.get("/api/image", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send("Path is required");
  }

  // Basic check to ensure file exists and is an image
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  const ext = path.extname(filePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) {
    return res.status(400).send("Only JPG/JPEG/PNG images are supported");
  }

  res.sendFile(filePath);
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
    const files = fs.readdirSync(targetPath);
    const images = [];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if ([".jpg", ".jpeg"].includes(ext)) {
        const fullPath = path.join(targetPath, file);
        const stats = fs.statSync(fullPath);
        
        // Read existing metadata to display
        let existingMetadata = {};
        try {
          const tags = await exiftool.read(fullPath);
          existingMetadata = {
            title: tags.Title || tags.ObjectName || tags.XPTitle || "",
            description: tags.Description || tags.ImageDescription || tags.CaptionAbstract || tags.UserComment || tags.Comment || tags.XPComment || "",
            keywords: tags.Keywords || tags.Subject || tags.XPKeywords || [],
            date: tags.DateTimeOriginal || tags.CreateDate || stats.mtime
          };
          if (!existingMetadata.keywords) {
            existingMetadata.keywords = [];
          } else if (typeof existingMetadata.keywords === "string") {
            existingMetadata.keywords = [existingMetadata.keywords];
          } else if (!Array.isArray(existingMetadata.keywords)) {
            existingMetadata.keywords = Array.from(existingMetadata.keywords);
          }
        } catch (err) {
          console.error(`Error reading metadata for ${file}:`, err);
        }

        images.push({
          name: file,
          path: fullPath,
          size: stats.size,
          metadata: existingMetadata,
          analyzed: !!(existingMetadata.title || existingMetadata.description || (existingMetadata.keywords && existingMetadata.keywords.length > 0))
        });
      }
    }

    res.json({ success: true, images, resolvedPath: targetPath });
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
  const { filePath, customPrompt, landmarksDb } = req.body;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: "Valid file path is required" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set in backend .env file" });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const base64Image = fileBuffer.toString("base64");

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
- Language: Italian.

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

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image
                }
              }
            ]
          }
        ]
      })
    });

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

// Serve static frontend files in production
const frontendBuildPath = path.join(__dirname, "../frontend/dist");
app.use(express.static(frontendBuildPath));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  const indexFile = path.join(frontendBuildPath, "index.html");
  if (fs.existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.status(404).send("Frontend not built. Please run npm run build in frontend directory.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PhotoArchivist AI server running on http://localhost:${PORT}`);
});
