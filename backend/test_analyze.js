
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const filePath = "/Users/mattiaianniello/Desktop/2026.03 - ATENE JPG/MAT03289 CapOne.jpg";
  console.log("Testing analyze-gemini for file:", filePath);
  
  try {
    const response = await fetch("http://127.0.0.1:3001/api/analyze-gemini", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filePath,
        landmarksDb: {}
      })
    });
    
    console.log("Response status:", response.status);
    const data = await response.json();
    console.log("Response data:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Fetch error:", err);
  }
}

main();
