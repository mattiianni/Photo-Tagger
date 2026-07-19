import React, { useState, useEffect, useRef } from 'react';
import * as faceapi from '@vladmandic/face-api';
import FaceTrainer from './components/FaceTrainer';
import LocationDbSettings from './components/LocationDbSettings';
import { detectAndMatchFaces, loadFaceApiModels } from './utils/faceRecognition';

const API_BASE = window.location.port === '5173'
  ? `http://${window.location.hostname}:3001`
  : window.location.origin;

const formatNamesItalian = (names) => {
  if (!names || names.length === 0) return "";
  const cleanNames = names.filter(n => n && n.trim() !== "");
  if (cleanNames.length === 0) return "";
  if (cleanNames.length === 1) return cleanNames[0];
  if (cleanNames.length === 2) return `${cleanNames[0]} e ${cleanNames[1]}`;
  return `${cleanNames.slice(0, -1).join(", ")} e ${cleanNames[cleanNames.length - 1]}`;
};

const removeDescriptorFromPerson = (personList, personName, faceDescriptor) => {
  if (!faceDescriptor || !personName || personName.toLowerCase() === 'sconosciuto' || personName.toLowerCase() === 'unknown') return personList;
  const targetPersonIdx = personList.findIndex(p => p.name.toLowerCase() === personName.toLowerCase());
  if (targetPersonIdx === -1) return personList;
  
  const targetPerson = personList[targetPersonIdx];
  let matchIdx = -1;
  for (let i = 0; i < targetPerson.descriptors.length; i++) {
    const d = targetPerson.descriptors[i];
    if (!d) continue;
    
    const dArray = d instanceof Float32Array ? d : Object.values(d);
    const faceArray = faceDescriptor instanceof Float32Array ? faceDescriptor : Object.values(faceDescriptor);
    
    if (dArray.length !== faceArray.length) continue;
    
    let isMatch = true;
    for (let j = 0; j < dArray.length; j++) {
      if (Math.abs(dArray[j] - faceArray[j]) > 0.001) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matchIdx = i;
      break;
    }
  }
  
  if (matchIdx !== -1) {
    const updatedPerson = { ...targetPerson };
    updatedPerson.descriptors = [...targetPerson.descriptors];
    updatedPerson.photos = [...targetPerson.photos];
    
    updatedPerson.descriptors.splice(matchIdx, 1);
    updatedPerson.photos.splice(matchIdx, 1);
    
    const newList = [...personList];
    newList[targetPersonIdx] = updatedPerson;
    return newList;
  }
  return personList;
};

function ImageWithFaceOverlays({ imagePath, faces, hoveredFaceIndex }) {
  const [imgDims, setImgDims] = useState(null);
  const imgRef = useRef(null);

  const handleImgLoad = () => {
    if (!imgRef.current) return;
    const { naturalWidth, naturalHeight, clientWidth, clientHeight } = imgRef.current;
    
    const imageRatio = naturalWidth / naturalHeight;
    const containerRatio = clientWidth / clientHeight;
    
    let renderedWidth, renderedHeight, offsetX, offsetY;
    if (imageRatio > containerRatio) {
      renderedWidth = clientWidth;
      renderedHeight = clientWidth / imageRatio;
      offsetX = 0;
      offsetY = (clientHeight - renderedHeight) / 2;
    } else {
      renderedHeight = clientHeight;
      renderedWidth = clientHeight * imageRatio;
      offsetX = (clientWidth - renderedWidth) / 2;
      offsetY = 0;
    }

    setImgDims({
      naturalWidth,
      naturalHeight,
      renderedWidth,
      renderedHeight,
      offsetX,
      offsetY
    });
  };

  useEffect(() => {
    const handleResize = () => handleImgLoad();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '180px', background: '#000', borderRadius: '8px', overflow: 'hidden' }}>
      <img
        ref={imgRef}
        src={`${API_BASE}/api/image?path=${encodeURIComponent(imagePath)}&size=preview`}
        alt="Anteprima"
        onLoad={handleImgLoad}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
      {imgDims && faces && faces.map((face, idx) => {
        if (!face.box) return null;
        
        const scaleX = imgDims.renderedWidth / imgDims.naturalWidth;
        const scaleY = imgDims.renderedHeight / imgDims.naturalHeight;
        
        const left = imgDims.offsetX + (face.box.x * scaleX);
        const top = imgDims.offsetY + (face.box.y * scaleY);
        const width = face.box.width * scaleX;
        const height = face.box.height * scaleY;
        
        const isUnknown = face.name === 'Sconosciuto' || face.name === 'unknown';
        const color = isUnknown ? '#ff4757' : '#2ed573';
        const isHovered = idx === hoveredFaceIndex;
        const borderThickness = isHovered ? '2.5px' : '1.5px';
        const glow = isHovered ? `0 0 10px ${color}, inset 0 0 10px ${color}` : '0 0 4px rgba(0,0,0,0.5)';
        const zIndex = isHovered ? 10 : 1;

        return (
          <div
            key={idx}
            style={{
              position: 'absolute',
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
              border: `${borderThickness} dashed ${color}`,
              borderRadius: '4px',
              pointerEvents: 'none',
              boxShadow: glow,
              zIndex,
              transition: 'all 0.15s ease'
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: '-16px',
                left: '-1px',
                background: color,
                color: '#fff',
                fontSize: '9px',
                fontWeight: 'bold',
                padding: '1px 4px',
                borderRadius: '3px 3px 3px 0',
                whiteSpace: 'nowrap',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                opacity: isHovered ? 1 : 0.8,
                transition: 'opacity 0.15s ease'
              }}
            >
              {face.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('photos'); // 'photos', 'faces', 'travel-db'
  const [dirPath, setDirPath] = useState(() => localStorage.getItem('last_dir_path') || '');
  const [images, setImages] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [globalTags, setGlobalTags] = useState(() => {
    try { return JSON.parse(localStorage.getItem('global_tags')) || []; }
    catch(e) { return []; }
  });
  const [newGlobalTag, setNewGlobalTag] = useState('');
  useEffect(() => { localStorage.setItem('global_tags', JSON.stringify(globalTags)); }, [globalTags]);

  // Modals & Settings
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
  const [hoveredFaceIndex, setHoveredFaceIndex] = useState(null);
  const [customPersonName, setCustomPersonName] = useState('');
  const [toasts, setToasts] = useState([]);
  const [selectedImagePaths, setSelectedImagePaths] = useState(new Set());
  const [filterState, setFilterState] = useState('all'); // 'all', 'analyzed', 'new', 'pending'
  
  // Resizer state
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = localStorage.getItem('inspector_width');
    return saved ? parseInt(saved, 10) : 340;
  });
  const isResizing = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing.current) return;
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth > 250 && newWidth < 800) {
        setInspectorWidth(newWidth);
        localStorage.setItem('inspector_width', newWidth);
      }
    };
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = 'default';
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const showToast = (message, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  const toggleImageSelection = (path) => {
    setSelectedImagePaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const clearImageSelection = () => {
    setSelectedImagePaths(new Set());
  };

  const manualCanvasRef = useRef(null);

  // Save API key to localStorage
  useEffect(() => {
    localStorage.setItem('gemini_api_key', apiKey);
  }, [apiKey]);

  const [isDragActive, setIsDragActive] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [people, setPeople] = useState([]);
  const [showAnalyzePrompt, setShowAnalyzePrompt] = useState(false);

  // Save last directory path
  useEffect(() => {
    if (dirPath) {
      localStorage.setItem('last_dir_path', dirPath);
    }
  }, [dirPath]);

  const savePeopleToBackend = async (newPeople) => {
    try {
      await fetch(`${API_BASE}/api/trained-people`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peopleList: newPeople })
      });
    } catch (err) {
      console.error("Failed to save trained people to backend:", err);
    }
  };

  const rebuildMatcher = (peopleList) => {
    try {
      const activePeople = peopleList.filter(p => p.descriptors && p.descriptors.length > 0);
      if (activePeople.length === 0) {
        setFaceMatcher(null);
        return;
      }
      const labeledDescriptors = activePeople.map(p => {
        const floatDescriptors = p.descriptors.map(d => new Float32Array(d));
        return new faceapi.LabeledFaceDescriptors(p.name, floatDescriptors);
      });
      const matcher = new faceapi.FaceMatcher(labeledDescriptors, 0.70);
      setFaceMatcher(matcher);
    } catch (err) {
      console.error('Error rebuilding matcher:', err);
    }
  };

  const updatePeopleList = async (newList) => {
    setPeople(newList);
    localStorage.setItem('trained_people', JSON.stringify(newList));
    rebuildMatcher(newList);
    await savePeopleToBackend(newList);
  };

  // Load and migrate trained people database on mount
  useEffect(() => {
    const initPeople = async () => {
      let loadedPeople = [];
      try {
        const res = await fetch(`${API_BASE}/api/trained-people`);
        if (res.ok) {
          loadedPeople = await res.json();
        } else {
          throw new Error("Server returned non-ok status");
        }
      } catch (err) {
        console.error("Failed to fetch trained people from backend, falling back to localStorage:", err);
        const saved = localStorage.getItem('trained_people');
        loadedPeople = saved ? JSON.parse(saved) : [
          { name: 'Mattia', photos: [], descriptors: [] },
          { name: 'Tiziana', photos: [], descriptors: [] },
          { name: 'Samuele', photos: [], descriptors: [] }
        ];
      }

      // Run migration
      try {
        let modified = false;
        for (const person of loadedPeople) {
          if (!person.photos) person.photos = [];
          for (let i = 0; i < person.photos.length; i++) {
            const photo = person.photos[i];
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
                  img.onerror = () => resolve(photo);
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
          await savePeopleToBackend(loadedPeople);
        }
      } catch (migrationErr) {
        console.error("Error during migration:", migrationErr);
      }

      setPeople(loadedPeople);
      localStorage.setItem('trained_people', JSON.stringify(loadedPeople));
      rebuildMatcher(loadedPeople);
    };

    initPeople();
  }, []);

  const ensureMetadataLoaded = async (img) => {
    if (!img || img.metadata !== null) return img;
    
    try {
      const response = await fetch(`${API_BASE}/api/image-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: img.path })
      });
      const data = await response.json();
      if (data.success) {
        const updated = { ...img, metadata: data.metadata, analyzed: data.analyzed };
        setImages(prev => prev.map(i => i.path === img.path ? updated : i));
        if (selectedImage && selectedImage.path === img.path) {
          setSelectedImage(updated);
        }
        return updated;
      }
    } catch (err) {
      console.error("Error loading metadata for selected image:", img.name, err);
    }
    return img;
  };

  const handleSelectImage = async (img) => {
    setSelectedImage(img);
    await ensureMetadataLoaded(img);
  };

  // Background metadata loader
  useEffect(() => {
    if (images.length === 0 || processing) return;

    const nextImg = images.find(img => img.metadata === null);
    if (!nextImg) return;

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/image-metadata`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: nextImg.path })
        });
        const data = await response.json();
        if (data.success) {
          setImages(prev => prev.map(img => 
            img.path === nextImg.path 
              ? { ...img, metadata: data.metadata, analyzed: data.analyzed }
              : img
          ));
          if (selectedImage && selectedImage.path === nextImg.path) {
            setSelectedImage({
              ...selectedImage,
              metadata: data.metadata,
              analyzed: data.analyzed
            });
          }
        }
      } catch (err) {
        console.error("Error loading background metadata for:", nextImg.name, err);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [images, processing, selectedImage?.path]);

  const handleScanFolder = async (pathOverride) => {
    const targetPath = (typeof pathOverride === 'string') ? pathOverride : dirPath;
    if (!targetPath) return showToast("Inserisci un percorso valido.", "error");
    setIsScanning(true);
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
          handleSelectImage(data.images[0]);
        }
        showToast("Scansione completata con successo!");
      } else {
        showToast("Errore durante la scansione: " + data.error, "error");
      }
    } catch (err) {
      console.error(err);
      showToast("Impossibile connettersi al backend locale. Assicurati che sia avviato.", "error");
    } finally {
      setIsScanning(false);
    }
  };

  const handlePickFolder = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/pick-folder`);
      const data = await response.json();
      if (data.success && data.path) {
        setDirPath(data.path);
        handleScanFolder(data.path);
      }
    } catch (err) {
      console.error(err);
      showToast("Impossibile aprire il selettore cartelle.", "error");
    }
  };

  // Downsample image in browser before sending to Gemini to save bandwidth and speed up analysis
  const downsampleImage = async (imagePath, maxDim = 1024) => {
    const url = `${API_BASE}/api/image?path=${encodeURIComponent(imagePath)}&size=preview`;
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
        const imageSrc = `${API_BASE}/api/image?path=${encodeURIComponent(img.path)}&size=preview`;
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

      // 2. Query Gemini Vision API (via local backend proxy) with retry and rate-limiting self-healing
      let data = null;
      let retries = 3;

      // Spacing delay to stay under the Free Tier 15 RPM rate limit (1 request every 4 seconds)
      if (processing) {
        await new Promise(resolve => setTimeout(resolve, 4000));
      }

      while (retries > 0) {
        try {
          const response = await fetch(`${API_BASE}/api/analyze-gemini`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey.trim()}` 
            },
            body: JSON.stringify({
              filePath: base64Image ? undefined : img.path,
              base64Image: base64Image ? base64Image.split(',')[1] : undefined,
              landmarksDb,
              detectedPeople: detectedFaces.filter(f => f.name && f.name !== 'Sconosciuto' && f.name !== 'unknown' && f.name !== 'Unknown').map(f => f.name),
              globalTags
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || `Server returned status ${response.status}`);
          }

          data = await response.json();
          if (!data.success) throw new Error(data.error);
          break; // Success! Exit retry loop
        } catch (fetchErr) {
          const errMsg = fetchErr.message || "";
          const isRateLimit = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.toLowerCase().includes("quota");
          
          retries--;
          if (isRateLimit && retries > 0) {
            let secondsToWait = 45;
            // Extract wait time from Gemini API message (e.g. "retry in 43.15s" or similar)
            const match = errMsg.match(/retry in ([\d.]+)\s*s/i) || errMsg.match(/retryDelay":\s*"(\d+)/);
            if (match && match[1]) {
              secondsToWait = Math.ceil(parseFloat(match[1])) + 2; // Add a 2s safety buffer
            }

            console.warn(`Rate limit reached for ${img.name}. Waiting ${secondsToWait} seconds before retrying...`);
            
            // Render a real-time countdown in the batch status bar
            for (let w = secondsToWait; w > 0; w--) {
              setCurrentProcessingName(`Quota superata. Attesa di ${w}s prima di riprovare...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            setCurrentProcessingName(img.name);
            continue;
          } else {
            throw fetchErr;
          }
        }
      }

      if (!data) throw new Error("Failed to receive analysis data after retries.");
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
        if (f.name && f.name !== 'Sconosciuto' && f.name !== 'unknown' && f.name !== 'Unknown') {
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

      // Ensure recognized faces are in the title and description
      const recognizedNames = detectedFaces
        .filter(f => f.name && f.name !== 'Sconosciuto' && f.name !== 'unknown' && f.name !== 'Unknown')
        .map(f => f.name);

      let finalTitle = analysis.title || img.metadata?.title || img.name;
      let finalDescription = analysis.description || img.metadata?.description || '';

      if (recognizedNames.length > 0) {
        const namesFormatted = formatNamesItalian(recognizedNames);
        
        // Ensure title contains all recognized names
        const containsNamesTitle = recognizedNames.every(name => finalTitle.toLowerCase().includes(name.toLowerCase()));
        if (!containsNamesTitle) {
          if (finalTitle) {
            finalTitle = `${namesFormatted} - ${finalTitle}`;
          } else {
            finalTitle = namesFormatted;
          }
        }

        // Ensure description contains all recognized names
        const containsNamesDesc = recognizedNames.every(name => finalDescription.toLowerCase().includes(name.toLowerCase()));
        if (!containsNamesDesc && finalDescription) {
          finalDescription = `${namesFormatted}: ${finalDescription}`;
        }
      }

      const updatedMetadata = {
        title: finalTitle,
        description: finalDescription,
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

  // Run batch analysis (with support for onlySelected and forceAll)
  const runBatchTagging = async (onlySelected = false, forceAll = false) => {
    const targetImages = onlySelected 
      ? images.filter(img => selectedImagePaths.has(img.path))
      : [...images];

    if (targetImages.length === 0) {
      showToast("Nessuna foto da analizzare.", "error");
      return;
    }
    
    setProcessing(true);
    setProgress(0);
    
    const updatedImages = [...images];
    
    for (let i = 0; i < targetImages.length; i++) {
      const targetImg = targetImages[i];
      const mainIdx = updatedImages.findIndex(img => img.path === targetImg.path);
      if (mainIdx === -1) continue;

      const img = updatedImages[mainIdx];
      // Skip if we are running the global process and this image was already analyzed (unless forceAll is true).
      // If the user selected specific images, we analyze them regardless of status.
      if (!onlySelected && !forceAll && img.analyzed) {
        setProgress(Math.round(((i + 1) / targetImages.length) * 100));
        continue;
      }
      setCurrentProcessingName(img.name);
      
      const newMeta = await analyzeImage(img);
      if (newMeta) {
        updatedImages[mainIdx] = {
          ...img,
          metadata: newMeta,
          analyzed: true,
          isNew: true
        };
        // Update live
        setImages([...updatedImages]);
        if (selectedImage && selectedImage.path === img.path) {
          setSelectedImage(updatedImages[mainIdx]);
        }
      }
      
      setProgress(Math.round(((i + 1) / targetImages.length) * 100));
    }
    
    setProcessing(false);
    setCurrentProcessingName('');
    showToast("Analisi batch completata!");
    if (onlySelected) {
      clearImageSelection();
    }
  };

  // Write single image metadata to file
  // Write single image metadata to file and optionally train face matcher
  const saveImageMetadata = async (img, currentPeopleList = null) => {
    let updatedPeople = currentPeopleList ? [...currentPeopleList] : null;
    let hasNewTraining = false;

    try {
      // Train faces if provided - DISABLED to avoid model poisoning with auto-predicted faces
      // Only explicitly verified faces in the UI will now be added to the training set.

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
        return { success: true, newPeopleList: updatedPeople, hasNewTraining };
      } else {
        console.error("Error writing metadata:", data.error);
        return { success: false, newPeopleList: updatedPeople, hasNewTraining };
      }
    } catch (err) {
      console.error(err);
      return { success: false, newPeopleList: updatedPeople, hasNewTraining };
    }
  };

  // Save all analyzed images to disk (with support for onlySelected)
  const saveAllMetadata = async (onlySelected = false, onlyNew = false) => {
    let toSave = images.filter(img => img.analyzed);
    if (onlySelected) {
      toSave = toSave.filter(img => selectedImagePaths.has(img.path));
    }
    if (onlyNew) {
      toSave = toSave.filter(img => img.isNew);
    }

    if (toSave.length === 0) {
      showToast("Nessuna foto selezionata/elaborata modificata da salvare.", "error");
      return;
    }

    setProcessing(true);
    let successCount = 0;
    
    let currentPeopleList = [...people];
    let anyTrainingUpdates = false;

    const pathsSuccessfullySaved = [];

    for (let i = 0; i < toSave.length; i++) {
      const img = toSave[i];
      setCurrentProcessingName(`Scrittura metadati e volti: ${img.name}`);
      const result = await saveImageMetadata(img, currentPeopleList);
      if (result.success) {
        successCount++;
        pathsSuccessfullySaved.push(img.path);
      }
      if (result.hasNewTraining) {
        currentPeopleList = result.newPeopleList;
        anyTrainingUpdates = true;
      }
      setProgress(Math.round(((i + 1) / toSave.length) * 100));
    }
    
    if (pathsSuccessfullySaved.length > 0) {
      setImages(prevImages => prevImages.map(img => 
        pathsSuccessfullySaved.includes(img.path) ? { ...img, isNew: false } : img
      ));
      
      // If the selected image is among those saved, update it too
      if (selectedImage && pathsSuccessfullySaved.includes(selectedImage.path)) {
        setSelectedImage(prev => ({...prev, isNew: false}));
      }
    }
    
    if (anyTrainingUpdates) {
      await updatePeopleList(currentPeopleList);
      showToast("Volti salvati nel database per il riconoscimento futuro!", "success");
    }

    setProcessing(false);
    setCurrentProcessingName('');
    setProgress(0);
    showToast(`Salvataggio completato per ${successCount} di ${toSave.length} immagini.`);
    if (onlySelected) {
      clearImageSelection();
    }
  };;

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
      },
      analyzed: true
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
      },
      analyzed: true
    };
    setSelectedImage(updatedImg);
    setImages(images.map(img => img.path === selectedImage.path ? updatedImg : img));
  };

  // rebuildMatcherFromLocalStorage is replaced by rebuildMatcher

  const handleManualAddFace = () => {
    if (!selectedImage) return;
    const imageSrc = `${API_BASE}/api/image?path=${encodeURIComponent(selectedImage.path)}&size=preview`;
    
    // Get first person in the trained list to set as default select option
    const trainedPeopleList = people.length > 0 ? people : [
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

  const handleIdentifyFace = async (faceIndex, chosenName) => {
    if (!selectedImage || !selectedImage.metadata || !selectedImage.metadata.faces) return;
    
    let name = chosenName;
    if (name === 'new') {
      const promptName = prompt("Inserisci il nome della nuova persona:");
      if (!promptName || !promptName.trim()) return;
      name = promptName.trim();
    }

    setAnalyzingSingle(true);

    try {
      const face = selectedImage.metadata.faces[faceIndex];
      if (!face) return;

      // 1. Crop face from original image to create thumbnail
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = `${API_BASE}/api/image?path=${encodeURIComponent(selectedImage.path)}&size=preview`;
      await new Promise((resolve) => (img.onload = resolve));

      // Bounding box of the face
      const box = face.box || { x: 0, y: 0, width: img.width, height: img.height };
      
      // Add 25% padding to the bounding box to give context
      const padX = box.width * 0.25;
      const padY = box.height * 0.25;
      const cx = Math.max(0, box.x - padX);
      const cy = Math.max(0, box.y - padY);
      const cw = Math.min(img.width - cx, box.width + padX * 2);
      const ch = Math.min(img.height - cy, box.height + padY * 2);

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);

      // Create an 80x80 thumbnail for the "Volti" list
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 80;
      thumbCanvas.height = 80;
      const thumbCtx = thumbCanvas.getContext('2d');
      thumbCtx.drawImage(canvas, 0, 0, 80, 80);
      const thumbBase64 = thumbCanvas.toDataURL('image/jpeg', 0.8);

      // 2. Save the face descriptor and photo to the people database (skip for Sconosciuto)
      let trainedPeopleList = [...people];
      
      const oldName = face.name;
      
      // If the face was previously assigned to someone else, REMOVE IT from their trained list!
      if (oldName && oldName.toLowerCase() !== name.toLowerCase()) {
        trainedPeopleList = removeDescriptorFromPerson(trainedPeopleList, oldName, face.descriptor);
      }

      if (name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown') {
        if (trainedPeopleList.length === 0) {
          trainedPeopleList = [
            { name: 'Mattia', photos: [], descriptors: [] },
            { name: 'Tiziana', photos: [], descriptors: [] },
            { name: 'Samuele', photos: [], descriptors: [] }
          ];
        }

        let targetPerson = trainedPeopleList.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (!targetPerson) {
          targetPerson = { name, photos: [], descriptors: [] };
          trainedPeopleList.push(targetPerson);
        }

        // Avoid pushing duplicates
        let alreadyHasDesc = false;
        if (face.descriptor) {
          const newFaceArray = face.descriptor instanceof Float32Array ? face.descriptor : Object.values(face.descriptor);
          alreadyHasDesc = targetPerson.descriptors.some(d => {
            const dArray = d instanceof Float32Array ? d : Object.values(d);
            if (dArray.length !== newFaceArray.length) return false;
            for (let j = 0; j < dArray.length; j++) {
              if (Math.abs(dArray[j] - newFaceArray[j]) > 0.001) return false;
            }
            return true;
          });
        }

        if (face.descriptor && !alreadyHasDesc) {
          targetPerson.photos.push(thumbBase64);
          targetPerson.descriptors.push(face.descriptor);
        }
      }
      
      await updatePeopleList(trainedPeopleList);

      // 3. Update the metadata in the React state for this image
      const updatedMeta = { ...selectedImage.metadata };
      const facesList = [...(updatedMeta.faces || [])];

      // Update this face's name and set confidence to 100%
      facesList[faceIndex] = {
        ...face,
        name,
        confidence: 100
      };
      updatedMeta.faces = facesList;

      // Add to keywords if not already there, removing Sconosciuto
      let keywordsList = [...(updatedMeta.keywords || [])];
      let filteredKeywords = keywordsList.filter(k => 
        k.toLowerCase() !== 'sconosciuto' && 
        k.toLowerCase() !== 'unknown'
      );
      let title = updatedMeta.title || "";
      let description = updatedMeta.description || "";

      setAnalyzingSingle(true);
      try {
        let instruction = "";
        const wasUnknown = (!oldName || oldName.toLowerCase() === 'sconosciuto' || oldName.toLowerCase() === 'unknown');
        if (wasUnknown) {
           instruction = `Aggiungi la persona chiamata "${name}" alla frase. Integra la persona nel contesto (ad esempio, se prima si parlava genericamente di "un uomo" o "un bambino", sostituiscilo con "${name}"). Correggi la grammatica e non lasciare frasi a metà.`;
        } else {
           instruction = `Sostituisci la persona chiamata "${oldName}" con "${name}". Correggi le concordanze di genere o numero se necessario, e non lasciare frasi a metà. Mantenere il contesto identico.`;
        }

        const response = await fetch(`${API_BASE}/api/rewrite-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
          body: JSON.stringify({
            title: title,
            description: description,
            instruction: instruction
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          updatedMeta.title = data.title || title;
          updatedMeta.description = data.description || description;
        }
      } catch (e) {
        console.error("AI text rewrite failed", e);
      }

      const updatedImage = {
        ...selectedImage,
        metadata: updatedMeta,
        analyzed: true
      };

      setSelectedImage(updatedImage);
      setImages(images.map(img => img.path === selectedImage.path ? updatedImage : img));
      
      // Save updated metadata to backend!
      await saveImageMetadata(updatedImage);

      showToast(`Volto associato a ${name} con successo!`);
    } catch (err) {
      console.error("Error identifying face:", err);
      showToast("Errore durante l'associazione del volto.", "error");
    } finally {
      setAnalyzingSingle(false);
    }
  };

  const handleRemoveFace = async (faceIndex) => {
    if (!selectedImage || !selectedImage.metadata || !selectedImage.metadata.faces) return;

    try {
      const updatedMeta = { ...selectedImage.metadata };
      const facesList = [...(updatedMeta.faces || [])];
      
      const removedFace = facesList.splice(faceIndex, 1)[0];
      const name = removedFace.name;

      updatedMeta.faces = facesList;
      
      // Remove the face from the trained people database if it was assigned to someone
      let trainedPeopleList = [...people];
      if (name && name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown') {
        trainedPeopleList = removeDescriptorFromPerson(trainedPeopleList, name, removedFace.descriptor);
        await updatePeopleList(trainedPeopleList);
      }

      // 1. Remove the name from keywords if it's no longer present in other faces
      const nameStillExists = facesList.some(f => f.name && f.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!nameStillExists && name && name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown') {
        const keywordsList = [...(updatedMeta.keywords || [])];
        updatedMeta.keywords = keywordsList.filter(k => k && k.trim().toLowerCase() !== name.trim().toLowerCase());
      }

      // 2. Remove the name from the title & description if present and not in other faces
      if (name && name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown' && !nameStillExists) {
        setAnalyzingSingle(true);
        try {
          const response = await fetch(`${API_BASE}/api/rewrite-text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
            body: JSON.stringify({
              title: updatedMeta.title || "",
              description: updatedMeta.description || "",
              instruction: `Rimuovi la persona chiamata "${name}" dalla frase, correggendo la grammatica (es. aggiustando singolare/plurale o togliendo congiunzioni inutili) e mantenendo il resto del contesto intatto.`
            })
          });
          if (response.ok) {
            const data = await response.json();
            updatedMeta.title = data.title || updatedMeta.title;
            updatedMeta.description = data.description || updatedMeta.description;
          }
        } catch (e) {
          console.error("AI text rewrite failed", e);
        }
      }

      const updatedImage = {
        ...selectedImage,
        metadata: updatedMeta,
        analyzed: true
      };

      setSelectedImage(updatedImage);
      setImages(images.map(img => img.path === selectedImage.path ? updatedImage : img));

      await saveImageMetadata(updatedImage);

    } catch (err) {
      console.error("Error removing face:", err);
      showToast("Errore durante la rimozione della persona.", "error");
    }
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
      img.crossOrigin = "anonymous";
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
      let detection = null;
      try {
        detection = await faceapi.detectSingleFace(cropImgElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15 }))
          .withFaceLandmarks()
          .withFaceDescriptor();
      } catch (detErr) {
        console.error("Error detecting face in cropped region:", detErr);
      }

      // We ALWAYS proceed with tagging and title/description update, even if face-api fails to extract landmarks!
      let trainedPeopleList = people.length > 0 ? [...people] : [
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

      // Only save to faceMatcher database if we got a valid descriptor
      if (detection) {
        targetPerson.photos.push(thumbBase64);
        targetPerson.descriptors.push(Array.from(detection.descriptor));
      }

      await updatePeopleList(trainedPeopleList);

      // 3. Update the metadata in the React state for this image
      const updatedMeta = { ...(selectedImage.metadata || {}) };
      
      // Add to detected faces list, and replace one "Sconosciuto" or "unknown" if present
      const facesList = [...(updatedMeta.faces || [])];
      const sconosciutoIdx = facesList.findIndex(f => 
        f.name.toLowerCase() === 'sconosciuto' || 
        f.name.toLowerCase() === 'unknown'
      );
      
      if (sconosciutoIdx > -1) {
        facesList[sconosciutoIdx] = { name, confidence: 100 };
      } else {
        if (!facesList.some(f => f.name.toLowerCase() === name.toLowerCase())) {
          facesList.push({ name, confidence: 100 });
        }
      }
      updatedMeta.faces = facesList;

      // Add to keywords if not already there
      const keywordsList = [...(updatedMeta.keywords || [])];
      
      // Also remove Sconosciuto/unknown from keywords if it was there
      const filteredKeywords = keywordsList.filter(k => 
        k.toLowerCase() !== 'sconosciuto' && 
        k.toLowerCase() !== 'unknown'
      );
      
      if (!filteredKeywords.includes(name)) {
        filteredKeywords.push(name);
      }
      updatedMeta.keywords = filteredKeywords;

      let title = updatedMeta.title || "";
      let description = updatedMeta.description || "";

      try {
        const response = await fetch(`${API_BASE}/api/rewrite-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
          body: JSON.stringify({
            title: title,
            description: description,
            instruction: `Aggiungi la persona chiamata "${name}" alla frase. Integra la persona nel contesto (ad esempio, se prima si parlava genericamente di "un uomo" o "un bambino", sostituiscilo con "${name}"). Correggi la grammatica e non lasciare frasi a metà.`
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          updatedMeta.title = data.title || title;
          updatedMeta.description = data.description || description;
        }
      } catch (e) {
        console.error("AI text rewrite failed", e);
      }

      const updatedImage = {
        ...selectedImage,
        metadata: updatedMeta,
        analyzed: true
      };

      setSelectedImage(updatedImage);
      setImages(images.map(img => img.path === selectedImage.path ? updatedImage : img));
      setShowManualCropModal(false);

      if (detection) {
        showToast(`Volto di ${name} registrato con successo!`);
      } else {
        showToast(`Tag "${name}" aggiunto con successo!`);
      }
    } catch (err) {
      console.error(err);
      showToast("Errore durante la registrazione del volto.", "error");
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
    img.crossOrigin = "anonymous";
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
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="url(#gradient)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <defs>
              <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#007AFF" />
                <stop offset="100%" stopColor="#34C759" />
              </linearGradient>
            </defs>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
          <h1 style={{ fontSize: '20px', fontWeight: '700', letterSpacing: '-0.5px' }}>Photo Tag Pro</h1>
        </div>

        <nav style={{ flexGrow: 1 }}>
          <div className="sidebar-header">Libreria</div>
          <ul className="sidebar-menu" style={{ marginBottom: '24px' }}>
            <li className={`sidebar-item ${activeTab === 'photos' ? 'active' : ''}`} onClick={() => setActiveTab('photos')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '8px', verticalAlign: 'middle', opacity: 0.8}}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
              <span>Foto</span>
            </li>
            <li className={`sidebar-item ${activeTab === 'faces' ? 'active' : ''}`} onClick={() => setActiveTab('faces')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '8px', verticalAlign: 'middle', opacity: 0.8}}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4-4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              <span>Volti</span>
            </li>
            <li className={`sidebar-item ${activeTab === 'travel-db' ? 'active' : ''}`} onClick={() => setActiveTab('travel-db')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '8px', verticalAlign: 'middle', opacity: 0.8}}><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>
              <span>Database Luoghi</span>
            </li>
          </ul>

          <div className="sidebar-header">Percorso Cartella</div>
          <div style={{ padding: '0 8px', marginBottom: '24px' }}>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <input 
                className="form-input" 
                style={{ flex: 1, minWidth: 0 }} 
                placeholder="/Users/.../Atene" 
                value={dirPath}
                onChange={(e) => setDirPath(e.target.value)}
              />
              <button 
                className="btn btn-secondary" 
                onClick={handlePickFolder}
                title="Sfoglia cartelle"
                style={{ padding: '8px', flexShrink: 0 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              </button>
            </div>
            <button 
              className="btn btn-primary" 
              style={{ width: '100%' }} 
              onClick={() => handleScanFolder()}
              disabled={isScanning}
            >
              {isScanning ? '⏳ Scansione...' : 'Carica Foto'}
            </button>
          </div>

          <div className="sidebar-header" style={{ marginTop: '16px' }}>Contesto & Tag Globali</div>
          <div style={{ padding: '0 8px', marginBottom: '24px' }}>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: '1.3' }}>
              Forza l'AI a contestualizzare queste parole (es. "Motor Show Bologna") in tutte le foto.
            </p>
            <div className="chips-container" style={{ marginBottom: globalTags.length > 0 ? '8px' : '0', padding: 0 }}>
              {globalTags.map(tag => (
                <span key={tag} className="chip">
                  {tag}
                  <button className="chip-remove" onClick={() => setGlobalTags(prev => prev.filter(t => t !== tag))}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="form-input"
                placeholder="Es. Parigi 2026..."
                value={newGlobalTag}
                onChange={e => setNewGlobalTag(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newGlobalTag.trim()) {
                    setGlobalTags(prev => [...new Set([...prev, newGlobalTag.trim()])]);
                    setNewGlobalTag('');
                  }
                }}
              />
              <button 
                className="btn btn-secondary"
                style={{ padding: '0 12px', flexShrink: 0 }}
                onClick={() => {
                  if (newGlobalTag.trim()) {
                    setGlobalTags(prev => [...new Set([...prev, newGlobalTag.trim()])]);
                    setNewGlobalTag('');
                  }
                }}
              >
                +
              </button>
            </div>
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
          <div className="toolbar-title" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <span>
              {activeTab === 'photos' && `Libreria Fotografica (${images.length} foto)`}
              {activeTab === 'faces' && 'Gestione Volti (Addestramento)'}
              {activeTab === 'travel-db' && 'Modifica Database dei Luoghi'}
            </span>
            {activeTab === 'photos' && images.length > 0 && (
              <select
                className="form-input"
                style={{ fontSize: '12px', padding: '4px 8px', width: '140px', minHeight: 'unset' }}
                value={filterState}
                onChange={(e) => setFilterState(e.target.value)}
              >
                <option value="all">Tutte le foto</option>
                <option value="new">🟢 Nuove</option>
                <option value="pending">🟠 In Attesa</option>
                <option value="analyzed">🔵 Analizzate</option>
              </select>
            )}
          </div>
          {activeTab === 'photos' && images.length > 0 && (
            <div className="toolbar-actions" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {selectedImagePaths.size > 0 ? (
                <>
                  <button 
                    className="btn btn-primary" 
                    onClick={() => runBatchTagging(true)} 
                    disabled={processing}
                  >
                    Analizza ({selectedImagePaths.size})
                  </button>
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => saveAllMetadata(true)} 
                    disabled={processing}
                  >
                    Salva ({selectedImagePaths.size})
                  </button>
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => {
                      setSelectedImagePaths(new Set());
                      setShiftStartIdx(null);
                    }} 
                    disabled={processing}
                    style={{ background: 'transparent' }}
                  >
                    Annulla
                  </button>
                </>
              ) : (
                <>
                  <button className="btn btn-secondary" onClick={() => {
                    const hasAnalyzed = images.some(img => img.analyzed);
                    if (hasAnalyzed) {
                      setShowAnalyzePrompt(true);
                    } else {
                      runBatchTagging(false, false);
                    }
                  }} disabled={processing}>
                    Analizza Tutto
                  </button>
                  {selectedImage && (
                    <button 
                      className="btn btn-secondary" 
                      onClick={async () => {
                        setProcessing(true);
                        const success = await saveImageMetadata(selectedImage);
                        setProcessing(false);
                        if (success) {
                          showToast(`Metadati salvati!`);
                        } else {
                          showToast("Errore durante il salvataggio.", "error");
                        }
                      }}
                      disabled={processing}
                    >
                      Salva Corrente
                    </button>
                  )}
                  {images.some(img => img.isNew) && (
                    <button className="btn btn-primary" onClick={() => saveAllMetadata(false, true)}>
                      Salva Nuove ({images.filter(img => img.isNew).length})
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={() => saveAllMetadata(false, false)} disabled={processing}>
                    Salva Tutte ({images.filter(img => img.analyzed).length})
                  </button>
                </>
              )}
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

        {!processing && images.length > 0 && images.filter(img => img.metadata === null).length > 0 && (
          <div>
            <div style={{ padding: '12px 24px', fontSize: '13px', display: 'flex', justifyContent: 'space-between', background: 'rgba(0, 122, 255, 0.08)', color: 'var(--accent-color)' }}>
              <span style={{ fontWeight: '500' }}>📥 Caricamento e lettura metadati foto...</span>
              <span style={{ fontWeight: '600' }}>
                {images.filter(img => img.metadata !== null).length} di {images.length} ({Math.round((images.filter(img => img.metadata !== null).length / images.length) * 100)}%)
              </span>
            </div>
            <div className="batch-progress-bar" style={{ height: '4px' }}>
              <div className="batch-progress-fill" style={{ 
                width: `${(images.filter(img => img.metadata !== null).length / images.length) * 100}%`,
                backgroundColor: 'var(--accent-color)',
                height: '100%'
              }}></div>
            </div>
          </div>
        )}

        <div className="grid-container">
          {isScanning && (
            <div className="glass-overlay">
              <div className="spinner"></div>
              <h3 style={{ margin: '8px 0 0 0', fontWeight: 600 }}>Scansione in corso...</h3>
              <p style={{ fontSize: '13px', opacity: 0.8, marginTop: '4px' }}>Analisi dei file nella cartella in corso.</p>
            </div>
          )}
          {activeTab === 'photos' && (
            images.length === 0 ? (
              <div 
                className="dropzone"
                onClick={handlePickFolder}
                style={{ cursor: 'pointer' }}
              >
                <div className="dropzone-icon" style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                </div>
                <h3>Nessuna cartella caricata</h3>
                <p style={{ marginTop: '8px' }}>Clicca qui per sfogliare e selezionare la cartella con le tue foto.</p>
              </div>
            ) : (
              <div className="photo-grid">
                {images.filter(img => {
                  if (filterState === 'all') return true;
                  if (filterState === 'new') return img.isNew;
                  if (filterState === 'analyzed') return img.analyzed && !img.isNew;
                  if (filterState === 'pending') return !img.analyzed && !img.isNew;
                  return true;
                }).map(img => (
                  <div 
                    key={img.path} 
                    className={`photo-card ${selectedImagePaths.has(img.path) ? 'selected' : ''}`}
                    onClick={(e) => {
                      if (e.target.tagName !== 'INPUT') {
                        toggleImageSelection(img.path);
                      }
                      handleSelectImage(img);
                    }}
                  >
                    <div className="photo-thumb-container" style={{ position: 'relative' }}>
                      <input 
                        type="checkbox"
                        checked={selectedImagePaths.has(img.path)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleImageSelection(img.path);
                        }}
                        style={{
                          position: 'absolute',
                          top: '12px',
                          left: '12px',
                          transform: 'scale(1.2)',
                          zIndex: 10,
                          cursor: 'pointer',
                          opacity: selectedImagePaths.has(img.path) ? 1 : 0.4
                        }}
                      />
                      <img 
                        src={`${API_BASE}/api/image?path=${encodeURIComponent(img.path)}&size=thumbnail`} 
                        alt={img.name} 
                        className="photo-thumb" 
                      />
                    </div>
                    <div className="photo-card-info">
                      <div className="photo-name">{img.name}</div>
                      <div className="photo-status">
                        {img.isNew ? (
                          <span className="badge badge-success">Nuova</span>
                        ) : img.analyzed ? (
                          <span className="badge badge-primary">Analizzata</span>
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
              <FaceTrainer 
                people={people} 
                onPeopleUpdated={updatePeopleList} 
                onMatcherUpdated={setFaceMatcher} 
              />
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
        <>
          <div 
            className="inspector-resizer"
            onMouseDown={(e) => {
              e.preventDefault();
              isResizing.current = true;
              document.body.style.cursor = 'col-resize';
            }}
          />
          <aside className="inspector glass" style={{ width: `${inspectorWidth}px` }}>
          <div className="inspector-section" style={{ textAlign: 'center' }}>
            <ImageWithFaceOverlays 
              imagePath={selectedImage.path} 
              faces={selectedImage.metadata?.faces || []} 
              hoveredFaceIndex={hoveredFaceIndex} 
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
                <div 
                  key={index} 
                  style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    fontSize: '12px', 
                    background: 'var(--input-bg)', 
                    padding: '6px 10px', 
                    borderRadius: '6px',
                    border: hoveredFaceIndex === index ? '1px solid var(--accent-color)' : '1px solid transparent',
                    boxShadow: hoveredFaceIndex === index ? '0 0 6px rgba(var(--accent-color-rgb), 0.3)' : 'none',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={() => setHoveredFaceIndex(index)}
                  onMouseLeave={() => setHoveredFaceIndex(null)}
                >
                  <span style={{ fontWeight: '500' }}>👤 {face.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <select
                      className="form-select"
                      style={{ padding: '2px 4px', fontSize: '11px', borderRadius: '4px', width: 'auto', minWidth: '100px' }}
                      value={face.name}
                      onChange={(e) => handleIdentifyFace(index, e.target.value)}
                    >
                      <option value="Sconosciuto">Sconosciuto</option>
                      {people.map(p => (
                        <option key={p.name} value={p.name}>{p.name}</option>
                      ))}
                      <option value="new">+ Nuova persona...</option>
                    </select>
                    <button
                      title="Rimuovi persona rilevata"
                      onClick={() => handleRemoveFace(index)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#ff4d4d',
                        fontSize: '16px',
                        cursor: 'pointer',
                        padding: '2px 4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        transition: 'background 0.2s',
                        marginLeft: '4px'
                      }}
                    >
                      ⊖
                    </button>
                  </div>
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
              setAnalyzingSingle(true);
              analyzeImage(selectedImage).then(meta => {
                setAnalyzingSingle(false);
                if (meta) {
                  // If an image is successfully saved individually, remove its isNew flag
                  const updated = { ...selectedImage, metadata: meta, analyzed: true, isNew: false };
                  setSelectedImage(updated);
                  setImages(images.map(img => img.path === selectedImage.path ? updated : img));
                  showToast("Foto rielaborata con successo!");
                } else {
                  showToast("Impossibile analizzare la foto.", "error");
                }
              }).catch((err) => {
                setAnalyzingSingle(false);
                console.error(err);
                showToast("Errore durante l'analisi della foto.", "error");
              });
            }}
          >
            {analyzingSingle ? '⏳ Analisi in corso...' : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                Rielabora Foto
              </>
            )}
          </button>

          <button 
            className="btn btn-success" 
            style={{ width: '100%', marginTop: '10px', backgroundColor: 'var(--success-color)', borderColor: 'var(--success-color)', color: '#fff' }}
            disabled={processing || analyzingSingle}
            onClick={async () => {
              setProcessing(true);
              const success = await saveImageMetadata(selectedImage);
              setProcessing(false);
              if (success) {
                showToast(`Metadati di "${selectedImage.name}" salvati su disco!`);
              } else {
                showToast("Errore durante il salvataggio dei metadati.", "error");
              }
            }}
          >
            {processing ? '⏳ Salvataggio...' : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                Salva Foto
              </>
            )}
          </button>
        </aside>
        </>
      )}

      {/* Manual Cropper Modal */}
      {showManualCropModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '600px', width: '95%', padding: '24px' }}>
            <h3 style={{ marginTop: 0, marginBottom: '8px', fontSize: '18px', fontWeight: '600' }}>
              Aggiungi Volto Manualmente
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 0, marginBottom: '16px' }}>
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
                  const list = people.length > 0 ? people : [
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

      {/* Analyze Prompt Modal */}
      {showAnalyzePrompt && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px', fontWeight: 600 }}>Modalità di Analisi</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '30px', fontSize: '14px', lineHeight: '1.4' }}>
              Hai già analizzato alcune foto in questa cartella. Vuoi analizzare TUTTE le foto (sovrascrivendo quelle già fatte) o SOLO QUELLE NON ELABORATE?
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <button 
                className="btn btn-primary" 
                onClick={() => {
                  setShowAnalyzePrompt(false);
                  runBatchTagging(false, false);
                }}
                style={{ width: '100%', padding: '12px', fontSize: '14px' }}
              >
                SOLO NON ELABORATE
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={() => {
                  setShowAnalyzePrompt(false);
                  runBatchTagging(false, true);
                }}
                style={{ width: '100%', padding: '12px', fontSize: '14px' }}
              >
                TUTTE
              </button>
              <button 
                className="btn" 
                onClick={() => setShowAnalyzePrompt(false)}
                style={{ width: '100%', marginTop: '8px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontWeight: 500 }}
              >
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification Container */}
      <div className="toast-container" style={{ position: 'fixed', bottom: '20px', right: '20px', display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 99999 }}>
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`} style={{
            background: t.type === 'error' ? 'rgba(255, 77, 77, 0.95)' : 'rgba(0, 122, 255, 0.95)',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            fontSize: '13px',
            fontWeight: '500',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.2s ease-in-out'
          }}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
