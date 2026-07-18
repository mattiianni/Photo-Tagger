import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Invalid JSON: " + data));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log("Fetching accessible Gemini models list...");
  try {
    const data = await httpsGet(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (data.models) {
      console.log("Accessible models list:");
      for (const m of data.models) {
        console.log(`- Name: ${m.name}`);
        console.log(`  Supported Actions: ${m.supportedGenerationMethods.join(", ")}`);
      }
    } else {
      console.log("Error response:", JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error("Error:", err);
  }
}

main();
