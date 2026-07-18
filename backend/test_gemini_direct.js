import fs from 'fs';
import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

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

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const filePath = "/Users/mattiaianniello/Desktop/2026.03 - ATENE JPG/MAT03289 CapOne.jpg";
  console.log("Reading file...");
  const fileBuffer = fs.readFileSync(filePath);
  const base64Image = fileBuffer.toString("base64");
  
  console.log("Sending direct HTTPS request to Gemini API...");
  try {
    const response = await httpsPost(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Analyze this image and return a JSON object with a 'title' field." },
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
    );
    
    console.log("Response status:", response.status);
    const data = await response.json();
    console.log("Response data:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Direct fetch error:", err);
  }
}

main();
