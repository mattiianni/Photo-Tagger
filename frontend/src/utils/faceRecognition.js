import * as faceapi from '@vladmandic/face-api';

let modelsLoaded = false;

export async function loadFaceApiModels() {
  if (modelsLoaded) return;
  
  // Load models from the public/models directory of our Vite server
  await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
  await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
  
  modelsLoaded = true;
  console.log('face-api.js models loaded successfully.');
}

/**
 * Trains the FaceMatcher using a list of labels and their reference photo URLs.
 * @param {Array<{ label: string, imageUrls: string[] }>} peopleList
 * @returns {Promise<faceapi.FaceMatcher>}
 */
export async function createFaceMatcher(peopleList) {
  await loadFaceApiModels();
  
  const labeledDescriptors = [];
  
  for (const person of peopleList) {
    const descriptors = [];
    for (const url of person.imageUrls) {
      try {
        const img = await faceapi.fetchImage(url);
        const detection = await faceapi.detectSingleFace(img)
          .withFaceLandmarks()
          .withFaceDescriptor();
          
        if (detection) {
          descriptors.push(detection.descriptor);
        } else {
          console.warn(`No face detected in training photo: ${url}`);
        }
      } catch (err) {
        console.error(`Error loading training image for ${person.label}: ${url}`, err);
      }
    }
    
    if (descriptors.length > 0) {
      labeledDescriptors.push(new faceapi.LabeledFaceDescriptors(person.label, descriptors));
    }
  }
  
  if (labeledDescriptors.length === 0) {
    return null;
  }
  
  // Create a matcher with a threshold (distance metric, default 0.6. Lower is stricter)
  return new faceapi.FaceMatcher(labeledDescriptors, 0.55);
}

/**
 * Detects and identifies faces in an image element or URL.
 * @param {string|HTMLImageElement} imageInput - Local server URL or image element
 * @param {faceapi.FaceMatcher} matcher
 * @returns {Promise<Array<{ name: string, distance: number, box: any }>>}
 */
export async function detectAndMatchFaces(imageInput, matcher) {
  await loadFaceApiModels();
  
  let img;
  if (typeof imageInput === 'string') {
    img = await faceapi.fetchImage(imageInput);
  } else {
    img = imageInput;
  }
  
  const detections = await faceapi.detectAllFaces(img)
    .withFaceLandmarks()
    .withFaceDescriptors();
    
  if (!detections || detections.length === 0) {
    return [];
  }
  
  if (!matcher) {
    return detections.map(d => ({
      name: 'Sconosciuto',
      distance: 1.0,
      box: d.detection.box
    }));
  }
  
  return detections.map(d => {
    const bestMatch = matcher.findBestMatch(d.descriptor);
    return {
      name: bestMatch.label,
      distance: bestMatch.distance,
      // Confidence score as a percentage (1 - distance)
      confidence: Math.round((1 - bestMatch.distance) * 100),
      box: d.detection.box
    };
  });
}
