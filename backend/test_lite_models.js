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

async function testModel(modelName, base64Image, apiKey) {
  console.log(`Testing model: ${modelName}...`);
  try {
    const response = await httpsPost(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
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
    
    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response snippet: ${text.substring(0, 300)}`);
    return response.ok;
  } catch (err) {
    console.error(`Error with model ${modelName}:`, err.message);
    return false;
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const filePath = "/Users/mattiaianniello/Desktop/2026.03 - ATENE JPG/MAT03289 CapOne.jpg";
  console.log("Reading file...");
  const fileBuffer = fs.readFileSync(filePath);
  const base64Image = fileBuffer.toString("base64");
  
  const models = ["gemini-2.0-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-flash-lite-latest"];
  for (const model of models) {
    const ok = await testModel(model, base64Image, apiKey);
    console.log(`Model ${model} result: ${ok ? "SUCCESS" : "FAILED"}`);
    console.log("-----------------------------------------");
  }
}

main();
