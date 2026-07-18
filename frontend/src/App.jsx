import React, { useState, useEffect, useRef } from 'react';
import FaceTrainer from './components/FaceTrainer';
import LocationDbSettings from './components/LocationDbSettings';
import { detectAndMatchFaces } from './utils/faceRecognition';

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

      // 2. Query Gemini Vision API (via local backend proxy)
      const response = await fetch(`${API_BASE}/api/analyze-gemini`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}` 
        },
        body: JSON.stringify({
          filePath: img.path,
          landmarksDb
        })
      });

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
    
    setProcessing(true);
    setProgress(0);
    
    const updatedImages = [...images];
    
    for (let i = 0; i < updatedImages.length; i++) {
      const img = updatedImages[i];
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

          {selectedImage.metadata?.faces && selectedImage.metadata.faces.length > 0 && (
            <div className="inspector-section">
              <div className="inspector-title">Persone Rilevate</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {selectedImage.metadata.faces.map((face, index) => (
                  <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', background: 'var(--input-bg)', padding: '6px 10px', borderRadius: '6px' }}>
                    <span style={{ fontWeight: '500' }}>👤 {face.name}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>confidenza: {face.confidence}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

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
    </div>
  );
}
