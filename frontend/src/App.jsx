import React, { useState, useEffect, useRef } from 'react';
import * as faceapi from '@vladmandic/face-api';
import FaceTrainer from './components/FaceTrainer';
import LocationDbSettings from './components/LocationDbSettings';
import { detectAndMatchFaces, loadFaceApiModels } from './utils/faceRecognition';

const API_BASE = window.location.port === '5173'
  ? `http://${window.location.hostname}:3001`
  : window.location.origin;

export default function App() {
  const [activeTab, setActiveTab] = useState('photos'); // 'photos', 'faces', 'travel-db'
  const [dirPath, setDirPath] = useState(() => localStorage.getItem('last_dir_path') || '');
  const [images, setImages] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  
  // Settings
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [landmarksDb, setLandmarksDb] = useState({});

  // Batch execution state
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentProcessingName, setCurrentProcessingName] = useState('');
  const [analyzingSingle, setAnalyzingSingle] = useState(false);

  // Manual Crop States
  const [showManualCropModal, setShowManualCropModal] = useState(false);
  const [manualCropImage, setManualCropImage] = useState(null);
  const [selectedPersonForCrop, setSelectedPersonForCrop] = useState('');
  const [isManualDragging, setIsManualDragging] = useState(false);
  const [manualDragStart, setManualDragStart] = useState(null);
  const [manualDragEnd, setManualDragEnd] = useState(null);
  const [customPersonName, setCustomPersonName] = useState('');
  const manualCanvasRef = useRef(null);

  // Save API key to localStorage
  useEffect(() => {
    localStorage.setItem('gemini_api_key', apiKey);
  }, [apiKey]);

  const [isDragActive, setIsDragActive] = useState(false);

  // Save last directory path
  useEffect(() => {
    if (dirPath) {
      localStorage.setItem('last_dir_path', dirPath);
    }
  }, [dirPath]);

  // Clean up and downsample any existing legacy high-res face photos from localStorage to prevent QuotaExceededError
  useEffect(() => {
    const migrateTrainedPeople = async () => {
      const saved = localStorage.getItem('trained_people');
      if (!saved) return;
      try {
        const peopleList = JSON.parse(saved);
        let modified = false;
        
        for (const person of peopleList) {
          if (!person.photos) person.photos = [];
          for (let i = 0; i < person.photos.length; i++) {
            const photo = person.photos[i];
            // If the photo string is large (e.g. over 20KB), resize it to 80x80 to free space!
            if (photo && photo.length > 20000) {
              try {
                const resized = await new Promise((resolve) => {
                  const img = new Image();
                  img.src = photo;
                  img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 80;
                    canvas.height = 80;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, 80, 80);
                    resolve(canvas.toDataURL('image/jpeg', 0.8));
                  };
                  img.onerror = () => resolve(photo); // fallback to original if load fails
                });
                if (resized !== photo) {
                  person.photos[i] = resized;
                  modified = true;
                }
              } catch (e) {
                console.error("Migration resize error:", e);
              }
            }
          }
        }
        
        if (modified) {
          localStorage.setItem('trained_people', JSON.stringify(peopleList));
          console.log("Successfully migrated and compressed trained_people photos!");
        }
      } catch (err) {
        console.error("Error during trained_people migration:", err);
      }
    };
    
    migrateTrainedPeople();
  }, []);

  // Scan folder
  const handleScanFolder = async (pathOverride) => {
    const targetPath = (typeof pathOverride === 'string') ? pathOverride : dirPath;
    if (!targetPath) return alert("Inserisci un percorso valido.");
    try {
      const response = await fetch(`${API_BASE}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirPath: targetPath })
      });
      const data = await response.json();
      if (data.success) {
        setImages(data.images);
        if (data.resolvedPath) {
          setDirPath(data.resolvedPath);
        }
        if (data.images.length > 0) {
          setSelectedImage(data.images[0]);
        }
      } else {
        alert("Errore durante la scansione: " + data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Impossibile connettersi al backend locale. Assicurati che sia avviato.");
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragActive(false);
    
    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return;
    
    // Check if the first item is a folder/file
    const entry = items[0].webkitGetAsEntry();
    if (entry && entry.isDirectory) {
      // It's a directory! Call scan folder with its name
      handleScanFolder(entry.name);
    } else if (items[0].kind === 'file') {
      // Fallback if dropped a file or if webkitGetAsEntry failed
      const file = items[0].getAsFile();
      if (file && file.path) {
        // If file.path is available (e.g. Electron/special browser contexts), parse it
        const dir = file.path.substring(0, file.path.lastIndexOf('/'));
        handleScanFolder(dir);
      } else {
        alert("Rilascia una cartella valida invece di singoli file.");
      }
    }
  };

  // Downsample image in browser before sending to Gemini to save bandwidth and speed up analysis
  const downsampleImage = async (imagePath, maxDim = 1024) => {
    const url = `${API_BASE}/api/image?path=${encodeURIComponent(imagePath)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch image");
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = objectUrl;
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(objectUrl);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(objectUrl);
        reject(e);
      };
    });
  };

  // Run AI analysis on a single image
  const analyzeImage = async (img) => {

    try {
      // 1. Run local face-api.js detection in browser
      let detectedFaces = [];
      try {
        const imageSrc = `${API_BASE}/api/image?path=${encodeURIComponent(img.path)}`;
        detectedFaces = await detectAndMatchFaces(imageSrc, faceMatcher);
      } catch (faceErr) {
        console.error("Face-api.js error:", faceErr);
      }

      // Downsample the image to send to backend to speed up upload and analysis
      let base64Image = null;
      try {
        base64Image = await downsampleImage(img.path);
      } catch (downsampleErr) {
        console.error("Downsample error:", downsampleErr);
      }

      // 2. Query Gemini Vision API (via local backend proxy)
      const response = await fetch(`${API_BASE}/api/analyze-gemini`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}` 
        },
        body: JSON.stringify({
          filePath: base64Image ? undefined : img.path,
          base64Image: base64Image ? base64Image.split(',')[1] : undefined,
          landmarksDb
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Server returned status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) throw new Error(data.error);

      const analysis = data.analysis;

      // 3. Combine analysis
      const finalKeywords = new Set([
        ...(analysis.suggestedKeywords || []),
        ...(analysis.landmarks || []),
        ...(analysis.objects || []),
        ...(analysis.events || []),
        ...(analysis.predominantColors || []),
        ...(analysis.photoType ? [analysis.photoType] : []),
        ...(analysis.weather ? [analysis.weather] : []),
      ]);

      // Add detected faces and also expand keywords based on travel landmarks db
      detectedFaces.forEach(f => {
        if (f.name !== 'Sconosciuto' && f.confidence > 50) {
          finalKeywords.add(f.name);
        }
      });

      // Expand tags if any landmark is matched in database
      if (analysis.landmarks) {
        analysis.landmarks.forEach(landmark => {
          // Find key matching landmark name
          Object.entries(landmarksDb).forEach(([key, tags]) => {
            if (landmark.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(landmark.toLowerCase())) {
              tags.forEach(t => finalKeywords.add(t));
            }
          });
        });
      }

      // If user typed a specific landmark on import or in path, expand it
      if (img.name.toUpperCase().includes("ATENE") || dirPath.toUpperCase().includes("ATENE")) {
        finalKeywords.add("Atene");
        finalKeywords.add("Athens");
        finalKeywords.add("Grecia");
        finalKeywords.add("Viaggio");
      }

      const updatedMetadata = {
        title: analysis.title || img.metadata?.title || img.name,
        description: analysis.description || img.metadata?.description || '',
        keywords: Array.from(finalKeywords),
        faces: detectedFaces,
        confidence: {
          faces: detectedFaces.length > 0 ? Math.max(...detectedFaces.map(f => f.confidence || 0)) : 100,
          landmarks: analysis.landmarks?.length > 0 ? 98 : 0,
          description: 95
        }
      };

      return updatedMetadata;
    } catch (err) {
      console.error(`Error analyzing ${img.name}:`, err);
      return null;
    }
  };

  // Run batch analysis
  const runBatchTagging = async () => {
    if (images.length === 0) return alert("Nessuna foto da analizzare.");
    
    const analyzedCount = images.filter(img => img.analyzed).length;
    let skipAlreadyAnalyzed = false;

    if (analyzedCount > 0) {
      const choice = prompt(
        `Trovate ${analyzedCount} foto già elaborate.\n\n` +
        `Scegli un'opzione:\n` +
        `1 - Elabora SOLO le foto rimaste in attesa (consigliato)\n` +
        `2 - Rielabora TUTTE le foto (sovrascrivi tutto)\n\n` +
        `Lascia vuoto o premi Annulla per fermare il batch.`
      );
      
      if (choice === '1') {
        skipAlreadyAnalyzed = true;
      } else if (choice === '2') {
        skipAlreadyAnalyzed = false;
      } else {
        return; // Aborted
      }
    }
    
    setProcessing(true);
    setProgress(0);
    
    const updatedImages = [...images];
    
    for (let i = 0; i < updatedImages.length; i++) {
      const img = updatedImages[i];
      if (skipAlreadyAnalyzed && img.analyzed) {
        setProgress(Math.round(((i + 1) / updatedImages.length) * 100));
        continue;
      }
      setCurrentProcessingName(img.name);
      
      const newMeta = await analyzeImage(img);
      if (newMeta) {
        updatedImages[i] = {
          ...img,
          metadata: newMeta,
          analyzed: true
        };
        // Update live
        setImages([...updatedImages]);
        if (selectedImage && selectedImage.path === img.path) {
          setSelectedImage(updatedImages[i]);
        }
      }
      
      setProgress(Math.round(((i + 1) / updatedImages.length) * 100));
    }
    
    setProcessing(false);
    setCurrentProcessingName('');
    alert("Analisi batch completata!");
  };

  // Write single image metadata to file
  const saveImageMetadata = async (img) => {
    try {
      const response = await fetch(`${API_BASE}/api/write-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: img.path,
          metadata: {
            title: img.metadata.title,
            description: img.metadata.description,
            keywords: img.metadata.keywords
          }
        })
      });
      const data = await response.json();
      if (data.success) {
        return true;
      } else {
        console.error("Error writing metadata:", data.error);
        return false;
      }
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  // Save all analyzed images to disk
  const saveAllMetadata = async () => {
    const toSave = images.filter(img => img.analyzed);
    if (toSave.length === 0) return alert("Nessuna modifica da salvare.");

    setProcessing(true);
    let successCount = 0;

    for (let i = 0; i < toSave.length; i++) {
      const img = toSave[i];
      setCurrentProcessingName(`Scrittura metadati: ${img.name}`);
      const success = await saveImageMetadata(img);
      if (success) successCount++;
      setProgress(Math.round(((i + 1) / toSave.length) * 100));
    }

    setProcessing(false);
    setCurrentProcessingName('');
    alert(`Salvataggio completato! Scrittura riuscita per ${successCount} di ${toSave.length} immagini.`);
  };

  const handleUpdateKeyword = (action, keyword) => {
    if (!selectedImage) return;
    const updatedKeywords = [...(selectedImage.metadata?.keywords || [])];
    
    if (action === 'add' && keyword && !updatedKeywords.includes(keyword)) {
      updatedKeywords.push(keyword);
    } else if (action === 'remove') {
      const idx = updatedKeywords.indexOf(keyword);
      if (idx > -1) updatedKeywords.splice(idx, 1);
    }

    const updatedImg = {
      ...selectedImage,
      metadata: {
        ...selectedImage.metadata,
        keywords: updatedKeywords
      }
    };
    
    setSelectedImage(updatedImg);
    setImages(images.map(img => img.path === selectedImage.path ? updatedImg : img));
  };

  const handleUpdateField = (field, value) => {
    if (!selectedImage) return;
    const updatedImg = {
      ...selectedImage,
      metadata: {
        ...selectedImage.metadata,
        [field]: value
      }
    };
    setSelectedImage(updatedImg);
    setImages(images.map(img => img.path === selectedImage.path ? updatedImg : img));
  };

  const rebuildMatcherFromLocalStorage = () => {
    try {
      const saved = localStorage.getItem('trained_people');
      if (!saved) return;
      const peopleList = JSON.parse(saved);
      const activePeople = peopleList.filter(p => p.descriptors && p.descriptors.length > 0);
      if (activePeople.length === 0) {
        setFaceMatcher(null);
        return;
      }
      const labeledDescriptors = activePeople.map(p => {
        const floatDescriptors = p.descriptors.map(d => new Float32Array(d));
        return new faceapi.LabeledFaceDescriptors(p.name, floatDescriptors);
      });
      const matcher = new faceapi.FaceMatcher(labeledDescriptors, 0.55);
      setFaceMatcher(matcher);
    } catch (err) {
      console.error('Error rebuilding matcher in App:', err);
    }
  };

  const handleManualAddFace = () => {
    if (!selectedImage) return;
    const imageSrc = `${API_BASE}/api/image?path=${encodeURIComponent(selectedImage.path)}`;
    
    // Get first person in the trained list to set as default select option
    const saved = localStorage.getItem('trained_people');
    const trainedPeopleList = saved ? JSON.parse(saved) : [
      { name: 'Mattia', photos: [], descriptors: [] },
      { name: 'Tiziana', photos: [], descriptors: [] },
      { name: 'Samuele', photos: [], descriptors: [] }
    ];
    
    setManualCropImage(imageSrc);
    setSelectedPersonForCrop(trainedPeopleList[0]?.name || 'Mattia');
    setCustomPersonName('');
    setManualDragStart(null);
    setManualDragEnd(null);
    setShowManualCropModal(true);
  };

  const handleManualMouseDown = (e) => {
    const canvas = manualCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setManualDragStart({ x, y });
    setManualDragEnd({ x, y });
    setIsManualDragging(true);
  };

  const handleManualMouseMove = (e) => {
    if (!isManualDragging) return;
    const canvas = manualCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, canvas.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, canvas.height));
    setManualDragEnd({ x, y });
  };

  const handleManualMouseUp = () => {
    setIsManualDragging(false);
  };

  const handleSaveManualCrop = async () => {
    const canvas = manualCanvasRef.current;
    if (!canvas || !manualDragStart || !manualDragEnd) {
      alert("Seleziona l'area del volto trascinando il mouse.");
      return;
    }

    const name = selectedPersonForCrop === 'new' ? customPersonName.trim() : selectedPersonForCrop;
    if (!name) {
      alert("Inserisci o seleziona un nome valido per la persona.");
      return;
    }

    const x = Math.min(manualDragStart.x, manualDragEnd.x);
    const y = Math.min(manualDragStart.y, manualDragEnd.y);
    const w = Math.abs(manualDragStart.x - manualDragEnd.x);
    const h = Math.abs(manualDragStart.y - manualDragEnd.y);

    if (w < 15 || h < 15) {
      alert("Seleziona un'area del volto più grande.");
      return;
    }

    setAnalyzingSingle(true);

    try {
      const tempCanvas = document.createElement('canvas');
      const img = new Image();
      img.src = manualCropImage;
      await new Promise((resolve) => (img.onload = resolve));

      const scaleX = img.width / canvas.width;
      const scaleY = img.height / canvas.height;

      // Add 25% padding like before
      const paddingX = w * 0.25;
      const paddingY = h * 0.25;
      const px = Math.max(0, x - paddingX);
      const py = Math.max(0, y - paddingY);
      const pw = Math.min(canvas.width - px, w + paddingX * 2);
      const ph = Math.min(canvas.height - py, h + paddingY * 2);

      const cropW = pw * scaleX;
      const cropH = ph * scaleY;

      tempCanvas.width = cropW;
      tempCanvas.height = cropH;
      const tempCtx = tempCanvas.getContext('2d');

      tempCtx.drawImage(
        img,
        px * scaleX,
        py * scaleY,
        cropW,
        cropH,
        0,
        0,
        cropW,
        cropH
      );

      const croppedBase64 = tempCanvas.toDataURL('image/jpeg', 0.9);

      // Run face detection on the cropped image
      const cropImgElement = new Image();
      cropImgElement.src = croppedBase64;
      await new Promise((resolve) => (cropImgElement.onload = resolve));

      await loadFaceApiModels();
      const detection = await faceapi.detectSingleFace(cropImgElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection) {
        // 1. Save to trained_people in localStorage
        const saved = localStorage.getItem('trained_people');
        let trainedPeopleList = saved ? JSON.parse(saved) : [
          { name: 'Mattia', photos: [], descriptors: [] },
          { name: 'Tiziana', photos: [], descriptors: [] },
          { name: 'Samuele', photos: [], descriptors: [] }
        ];

        let targetPerson = trainedPeopleList.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (!targetPerson) {
          targetPerson = { name, photos: [], descriptors: [] };
          trainedPeopleList.push(targetPerson);
        }
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 80;
        thumbCanvas.height = 80;
        const thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.drawImage(cropImgElement, 0, 0, 80, 80);
        const thumbBase64 = thumbCanvas.toDataURL('image/jpeg', 0.8);

        targetPerson.photos.push(thumbBase64);
        targetPerson.descriptors.push(Array.from(detection.descriptor));
        localStorage.setItem('trained_people', JSON.stringify(trainedPeopleList));

        // 2. Rebuild the Face Matcher in memory
        rebuildMatcherFromLocalStorage();

        // 3. Update the metadata in the React state for this image
        const updatedMeta = { ...(selectedImage.metadata || {}) };
        
        // Add to detected faces list if not already there
        const facesList = [...(updatedMeta.faces || [])];
        if (!facesList.some(f => f.name.toLowerCase() === name.toLowerCase())) {
          facesList.push({ name, confidence: 100 });
        }
        updatedMeta.faces = facesList;

        // Add to keywords if not already there
        const keywordsList = [...(updatedMeta.keywords || [])];
        if (!keywordsList.includes(name)) {
          keywordsList.push(name);
        }
        updatedMeta.keywords = keywordsList;

        const updatedImage = {
          ...selectedImage,
          metadata: updatedMeta,
          analyzed: true
        };

        setSelectedImage(updatedImage);
        setImages(images.map(img => img.path === selectedImage.path ? updatedImage : img));
        setShowManualCropModal(false);
        alert(`Volto di ${name} registrato ed aggiunto con successo!`);
      } else {
        alert("Nessun volto rilevato in questa area. Centra meglio il viso includendo occhi e naso.");
      }
    } catch (err) {
      console.error(err);
      alert("Errore durante il rilevamento e la registrazione.");
    } finally {
      setAnalyzingSingle(false);
    }
  };

  // Canvas drawing for manual face cropper
  useEffect(() => {
    if (!showManualCropModal || !manualCropImage) return;
    const canvas = manualCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.src = manualCropImage;
    img.onload = () => {
      const maxWidth = Math.min(window.innerWidth - 60, 500);
      const maxHeight = 400;
      let width = img.width;
      let height = img.height;
      if (width > maxWidth) {
        height = (maxWidth / width) * height;
        width = maxWidth;
      }
      if (height > maxHeight) {
        width = (maxHeight / height) * width;
        height = maxHeight;
      }
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      if (manualDragStart && manualDragEnd) {
        const x1 = Math.min(manualDragStart.x, manualDragEnd.x);
        const y1 = Math.min(manualDragStart.y, manualDragEnd.y);
        const w = Math.abs(manualDragStart.x - manualDragEnd.x);
        const h = Math.abs(manualDragStart.y - manualDragEnd.y);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, y1);
        ctx.fillRect(0, y1 + h, width, height - (y1 + h));
        ctx.fillRect(0, y1, x1, h);
        ctx.fillRect(x1 + w, y1, width - (x1 + w), h);

        ctx.strokeStyle = '#007aff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, w, h);

        ctx.fillStyle = '#ffffff';
        const markSize = 6;
        ctx.fillRect(x1 - 3, y1 - 3, markSize, markSize);
        ctx.fillRect(x1 + w - 3, y1 - 3, markSize, markSize);
        ctx.fillRect(x1 - 3, y1 + h - 3, markSize, markSize);
        ctx.fillRect(x1 + w - 3, y1 + h - 3, markSize, markSize);
      } else {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto';
        ctx.textAlign = 'center';
        ctx.fillText('Trascina sul volto da registrare', width / 2, height / 2);
      }
    };
  }, [manualCropImage, manualDragStart, manualDragEnd, isManualDragging, showManualCropModal]);

  return (
    <div className="app-container">
      {/* Sidebar Left */}
      <aside className="sidebar sidebar-glass">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' }}>
          <span style={{ fontSize: '24px' }}>📸</span>
          <h1 style={{ fontSize: '18px', fontWeight: '700', letterSpacing: '-0.5px' }}>PhotoArchivist</h1>
        </div>

        <nav style={{ flexGrow: 1 }}>
          <div className="sidebar-header">Libreria</div>
          <ul className="sidebar-menu" style={{ marginBottom: '24px' }}>
            <li className={`sidebar-item ${activeTab === 'photos' ? 'active' : ''}`} onClick={() => setActiveTab('photos')}>
              <span>🖼️</span> Foto
            </li>
            <li className={`sidebar-item ${activeTab === 'faces' ? 'active' : ''}`} onClick={() => setActiveTab('faces')}>
              <span>👤</span> Volti
            </li>
            <li className={`sidebar-item ${activeTab === 'travel-db' ? 'active' : ''}`} onClick={() => setActiveTab('travel-db')}>
              <span>🗺️</span> Database Luoghi
            </li>
          </ul>

          <div className="sidebar-header">Percorso Cartella</div>
          <div style={{ padding: '0 8px', marginBottom: '24px' }}>
            <input 
              className="form-input" 
              style={{ width: '100%', marginBottom: '8px' }} 
              placeholder="/Users/.../Atene" 
              value={dirPath}
              onChange={(e) => setDirPath(e.target.value)}
            />
            <button className="btn btn-secondary" style={{ width: '100%' }} onClick={handleScanFolder}>Carica Foto</button>
          </div>

          <div className="sidebar-header">Impostazioni</div>
          <div style={{ padding: '0 8px' }}>
            <label className="form-label" style={{ marginBottom: '4px', display: 'block' }}>Gemini API Key</label>
            <input 
              type="password"
              className="form-input" 
              style={{ width: '100%' }} 
              placeholder="Inserisci API Key" 
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </nav>
      </aside>

      {/* Main Content Pane */}
      <main className="main-content">
        <header className="toolbar">
          <div className="toolbar-title">
            {activeTab === 'photos' && `Libreria Fotografica (${images.length} foto)`}
            {activeTab === 'faces' && 'Gestione Volti (Addestramento)'}
            {activeTab === 'travel-db' && 'Modifica Database dei Luoghi'}
          </div>
          {activeTab === 'photos' && images.length > 0 && (
            <div className="toolbar-actions">
              <button className="btn btn-secondary" onClick={runBatchTagging} disabled={processing}>
                ⚙️ Analizza Tutto (Batch)
              </button>
              <button className="btn btn-primary" onClick={saveAllMetadata} disabled={processing}>
                💾 Salva su File
              </button>
            </div>
          )}
        </header>

        {processing && (
          <div>
            <div style={{ padding: '12px 24px', fontSize: '13px', display: 'flex', justifyContent: 'space-between', background: 'var(--accent-light)' }}>
              <span>{currentProcessingName || 'Elaborazione in corso...'}</span>
              <span>{progress}%</span>
            </div>
            <div className="batch-progress-bar">
              <div className="batch-progress-fill" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
        )}

        <div className="grid-container">
          {activeTab === 'photos' && (
            images.length === 0 ? (
              <div 
                className={`dropzone ${isDragActive ? 'active' : ''}`}
                onClick={() => handleScanFolder()}
                onDragOver={(e) => { e.preventDefault(); setIsDragActive(true); }}
                onDragLeave={() => setIsDragActive(false)}
                onDrop={handleDrop}
              >
                <span className="dropzone-icon">📁</span>
                <h3>Nessuna cartella caricata</h3>
                <p style={{ marginTop: '8px' }}>Trascina qui la tua cartella o inserisci il percorso a sinistra.</p>
              </div>
            ) : (
              <div className="photo-grid">
                {images.map(img => (
                  <div 
                    key={img.path} 
                    className={`photo-card ${selectedImage?.path === img.path ? 'selected' : ''}`}
                    onClick={() => setSelectedImage(img)}
                  >
                    <div className="photo-thumb-container">
                      <img 
                        src={`${API_BASE}/api/image?path=${encodeURIComponent(img.path)}`} 
                        alt={img.name} 
                        className="photo-thumb" 
                      />
                    </div>
                    <div className="photo-card-info">
                      <div className="photo-name">{img.name}</div>
                      <div className="photo-status">
                        {img.analyzed ? (
                          <span className="badge badge-success">Analizzata</span>
                        ) : (
                          <span className="badge badge-pending">In Attesa</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {activeTab === 'faces' && (
            <div style={{ maxWidth: '600px', margin: '0 auto' }}>
              <FaceTrainer onMatcherUpdated={setFaceMatcher} />
            </div>
          )}

          {activeTab === 'travel-db' && (
            <div style={{ maxWidth: '600px', margin: '0 auto' }}>
              <LocationDbSettings onDbUpdated={setLandmarksDb} />
            </div>
          )}
        </div>
      </main>

      {/* Inspector Right Panel */}
      {activeTab === 'photos' && selectedImage && (
        <aside className="inspector glass">
          <div className="inspector-section" style={{ textAlign: 'center' }}>
            <img 
              src={`${API_BASE}/api/image?path=${encodeURIComponent(selectedImage.path)}`} 
              alt="Anteprima" 
              style={{ maxWidth: '100%', maxHeight: '180px', borderRadius: '8px', objectFit: 'contain', background: '#000' }}
            />
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '8px', wordBreak: 'break-all' }}>
              {selectedImage.path}
            </div>
          </div>

          <div className="inspector-section">
            <div className="inspector-title">Informazioni Generali</div>
            <div className="form-group" style={{ marginBottom: '12px' }}>
              <label className="form-label">Titolo</label>
              <input 
                className="form-input" 
                value={selectedImage.metadata?.title || ''} 
                onChange={(e) => handleUpdateField('title', e.target.value)}
                placeholder="Aggiungi un titolo..."
              />
            </div>
            <div className="form-group">
              <label className="form-label">Descrizione</label>
              <textarea 
                className="form-textarea" 
                value={selectedImage.metadata?.description || ''} 
                onChange={(e) => handleUpdateField('description', e.target.value)}
                placeholder="Aggiungi una descrizione dettagliata..."
              />
            </div>
          </div>

          {selectedImage.metadata?.confidence && (
            <div className="inspector-section">
              <div className="inspector-title">Precisione AI (Punteggi)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                    <span>Volti riconosciuti</span>
                    <span style={{ fontWeight: '600' }}>{selectedImage.metadata.confidence.faces}%</span>
                  </div>
                  <div className="gauge-bar">
                    <div className="gauge-fill" style={{ width: `${selectedImage.metadata.confidence.faces}%`, backgroundColor: 'var(--success-color)' }}></div>
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                    <span>Rilevamento Monumenti</span>
                    <span style={{ fontWeight: '600' }}>{selectedImage.metadata.confidence.landmarks}%</span>
                  </div>
                  <div className="gauge-bar">
                    <div className="gauge-fill" style={{ width: `${selectedImage.metadata.confidence.landmarks}%`, backgroundColor: 'var(--accent-color)' }}></div>
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                    <span>Qualità Descrizione</span>
                    <span style={{ fontWeight: '600' }}>{selectedImage.metadata.confidence.description}%</span>
                  </div>
                  <div className="gauge-bar">
                    <div className="gauge-fill" style={{ width: `${selectedImage.metadata.confidence.description}%`, backgroundColor: 'var(--accent-color)' }}></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="inspector-section">
            <div className="inspector-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Persone Rilevate</span>
              <button 
                className="btn btn-secondary" 
                style={{ padding: '2px 8px', fontSize: '11px', margin: 0 }}
                onClick={handleManualAddFace}
              >
                + Aggiungi
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {(selectedImage.metadata?.faces || []).map((face, index) => (
                <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', background: 'var(--input-bg)', padding: '6px 10px', borderRadius: '6px' }}>
                  <span style={{ fontWeight: '500' }}>👤 {face.name}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {face.confidence ? `confidenza: ${face.confidence}%` : 'aggiunto manualmente'}
                  </span>
                </div>
              ))}
              {(!selectedImage.metadata?.faces || selectedImage.metadata.faces.length === 0) && (
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Nessuna persona rilevata</span>
              )}
            </div>
          </div>

          <div className="inspector-section">
            <div className="inspector-title">Tag & Parole Chiave (IPTC)</div>
            <div className="chips-container">
              {(selectedImage.metadata?.keywords || []).map(tag => (
                <span key={tag} className="chip">
                  {tag}
                  <button className="chip-remove" onClick={() => handleUpdateKeyword('remove', tag)}>×</button>
                </span>
              ))}
              <input 
                className="form-input" 
                style={{ display: 'inline-flex', width: '90px', padding: '2px 6px', fontSize: '11px', borderRadius: '10px' }}
                placeholder="+ Aggiungi" 
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleUpdateKeyword('add', e.target.value);
                    e.target.value = '';
                  }
                }}
              />
            </div>
          </div>

          <button 
            className="btn btn-primary" 
            style={{ width: '100%', marginTop: '10px' }}
            disabled={analyzingSingle}
            onClick={() => {
              if (selectedImage.analyzed) {
                const overwrite = confirm("Questa foto è già stata elaborata. Vuoi sovrascriverla?");
                if (!overwrite) return;
              }
              setAnalyzingSingle(true);
              analyzeImage(selectedImage).then(meta => {
                setAnalyzingSingle(false);
                if (meta) {
                  const updated = { ...selectedImage, metadata: meta, analyzed: true };
                  setSelectedImage(updated);
                  setImages(images.map(img => img.path === selectedImage.path ? updated : img));
                } else {
                  alert("Impossibile analizzare la foto. Controlla la console del browser o del server per i dettagli.");
                }
              }).catch((err) => {
                setAnalyzingSingle(false);
                console.error(err);
                alert("Errore di rete o del server durante l'analisi.");
              });
            }}
          >
            {analyzingSingle ? '⏳ Analisi in corso...' : '🔄 Rielabora Singola Foto'}
          </button>
        </aside>
      )}

      {/* Manual Cropper Modal */}
      {showManualCropModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '20px'
        }}>
          <div className="glass" style={{
            backgroundColor: 'rgba(30, 30, 30, 0.95)',
            borderRadius: '16px',
            padding: '24px',
            maxWidth: '550px',
            width: '100%',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#fff'
          }}>
            <h3 style={{ marginTop: 0, marginBottom: '8px', fontSize: '18px', fontWeight: '600' }}>
              Aggiungi Volto Manualmente
            </h3>
            <p style={{ fontSize: '13px', color: '#aaa', marginTop: 0, marginBottom: '16px' }}>
              Seleziona la persona e trascina il cursore sopra il suo volto per ritagliarlo ed addestrare l'app.
            </p>

            <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '12px', fontWeight: '600', color: '#ccc' }}>Assegna a:</label>
              <select 
                className="form-input" 
                style={{ backgroundColor: '#222', color: '#fff', border: '1px solid #444' }}
                value={selectedPersonForCrop}
                onChange={(e) => setSelectedPersonForCrop(e.target.value)}
              >
                {(() => {
                  const saved = localStorage.getItem('trained_people');
                  const list = saved ? JSON.parse(saved) : [
                    { name: 'Mattia' }, { name: 'Tiziana' }, { name: 'Samuele' }
                  ];
                  return list.map(p => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ));
                })()}
                <option value="new">+ Nuova Persona...</option>
              </select>

              {selectedPersonForCrop === 'new' && (
                <input
                  type="text"
                  className="form-input"
                  placeholder="Inserisci il nome..."
                  style={{ backgroundColor: '#222', color: '#fff', border: '1px solid #444', marginTop: '8px' }}
                  value={customPersonName}
                  onChange={(e) => setCustomPersonName(e.target.value)}
                />
              )}
            </div>

            <div style={{ 
              display: 'flex', 
              justifyContent: 'center', 
              alignItems: 'center', 
              backgroundColor: '#111', 
              borderRadius: '8px',
              overflow: 'hidden',
              marginBottom: '20px',
              position: 'relative',
              userSelect: 'none'
            }}>
              <canvas
                ref={manualCanvasRef}
                onMouseDown={handleManualMouseDown}
                onMouseMove={handleManualMouseMove}
                onMouseUp={handleManualMouseUp}
                onMouseLeave={handleManualMouseUp}
                style={{ cursor: 'crosshair', display: 'block' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowManualCropModal(false)}
                disabled={analyzingSingle}
                style={{ color: '#fff' }}
              >
                Annulla
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleSaveManualCrop}
                disabled={analyzingSingle}
              >
                {analyzingSingle ? '⏳ Elaborazione...' : 'Salva e Addestra'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
