import React, { useState, useEffect, useRef } from 'react';
import * as faceapi from '@vladmandic/face-api';
import { loadFaceApiModels } from '../utils/faceRecognition';

export default function FaceTrainer({ people, onPeopleUpdated, onMatcherUpdated }) {
  // people state is now managed by parent App component
  
  const [training, setTraining] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  
  // Cropper Modal State
  const [showModal, setShowModal] = useState(false);
  const [cropImage, setCropImage] = useState(null);
  const [targetPersonIndex, setTargetPersonIndex] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  
  const canvasRef = useRef(null);

  // rebuildMatcher is handled by parent App component

  // Handle canvas drawing for cropper
  useEffect(() => {
    if (!showModal || !cropImage) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const img = new Image();
    img.src = cropImage;
    img.onload = () => {
      // Scale canvas to fit screen while keeping aspect ratio
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
      
      // Draw selection overlay
      if (dragStart && dragEnd) {
        const x1 = Math.min(dragStart.x, dragEnd.x);
        const y1 = Math.min(dragStart.y, dragEnd.y);
        const w = Math.abs(dragStart.x - dragEnd.x);
        const h = Math.abs(dragStart.y - dragEnd.y);
        
        // Draw dark semi-transparent overlay on outer areas
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, width, y1);
        ctx.fillRect(0, y1 + h, width, height - (y1 + h));
        ctx.fillRect(0, y1, x1, h);
        ctx.fillRect(x1 + w, y1, width - (x1 + w), h);
        
        // Selection border
        ctx.strokeStyle = '#007aff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, w, h);
        
        // Target corner marks
        ctx.fillStyle = '#ffffff';
        const markSize = 6;
        ctx.fillRect(x1 - 3, y1 - 3, markSize, markSize);
        ctx.fillRect(x1 + w - 3, y1 - 3, markSize, markSize);
        ctx.fillRect(x1 - 3, y1 + h - 3, markSize, markSize);
        ctx.fillRect(x1 + w - 3, y1 + h - 3, markSize, markSize);
      } else {
        // Draw hint text initially
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto';
        ctx.textAlign = 'center';
        ctx.fillText('Trascina sul volto per ritagliarlo', width / 2, height / 2);
      }
    };
  }, [cropImage, dragStart, dragEnd, isDragging, showModal]);

  // rebuildMatcher is handled by parent App component

  const handlePhotoSelect = async (personIndex, e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = () => {
      setCropImage(reader.result);
      setTargetPersonIndex(personIndex);
      setDragStart(null);
      setDragEnd(null);
      setShowModal(true);
    };
    reader.readAsDataURL(file);
    // Reset file input
    e.target.value = '';
  };

  const handleMouseDown = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDragStart({ x, y });
    setDragEnd({ x, y });
    setIsDragging(true);
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, canvas.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, canvas.height));
    setDragEnd({ x, y });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleConfirmCrop = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !dragStart || !dragEnd) {
      alert("Disegna una selezione sul volto prima di confermare.");
      return;
    }
    
    let x = Math.min(dragStart.x, dragEnd.x);
    let y = Math.min(dragStart.y, dragEnd.y);
    let w = Math.abs(dragStart.x - dragEnd.x);
    let h = Math.abs(dragStart.y - dragEnd.y);
    
    if (w < 15 || h < 15) {
      alert("Seleziona un'area del volto più grande.");
      return;
    }

    // Add 25% padding on all sides to give face-api some head context
    const paddingX = w * 0.25;
    const paddingY = h * 0.25;
    x = Math.max(0, x - paddingX);
    y = Math.max(0, y - paddingY);
    w = Math.min(canvas.width - x, w + paddingX * 2);
    h = Math.min(canvas.height - y, h + paddingY * 2);
    
    setTraining(true);
    setStatusMessage(`Analisi del volto per ${people[targetPersonIndex].name}...`);
    
    try {
      // Load original high-resolution image to crop from it for max detail
      const img = new Image();
      img.src = cropImage;
      await new Promise((resolve) => (img.onload = resolve));
      
      // Calculate scale ratio between high-res image and canvas
      const scaleX = img.width / canvas.width;
      const scaleY = img.height / canvas.height;
      
      const cropW = w * scaleX;
      const cropH = h * scaleY;
      
      // Crop onto a temporary canvas at high resolution
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = cropW;
      tempCanvas.height = cropH;
      const tempCtx = tempCanvas.getContext('2d');
      
      tempCtx.drawImage(
        img,
        x * scaleX,
        y * scaleY,
        cropW,
        cropH,
        0,
        0,
        cropW,
        cropH
      );
      
      const croppedBase64 = tempCanvas.toDataURL('image/jpeg', 0.9);
      
      // Run detection on the crop
      const cropImgElement = new Image();
      cropImgElement.src = croppedBase64;
      await new Promise((resolve) => (cropImgElement.onload = resolve));
      
      await loadFaceApiModels();
      const detection = await faceapi.detectSingleFace(cropImgElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
        
      if (detection) {
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 80;
        thumbCanvas.height = 80;
        const thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.drawImage(cropImgElement, 0, 0, 80, 80);
        const thumbBase64 = thumbCanvas.toDataURL('image/jpeg', 0.8);

        const updatedPeople = [...people];
        updatedPeople[targetPersonIndex].photos.push(thumbBase64);
        updatedPeople[targetPersonIndex].descriptors.push(Array.from(detection.descriptor));
        onPeopleUpdated(updatedPeople);
        setStatusMessage(`Volto di ${people[targetPersonIndex].name} registrato!`);
        setShowModal(false);
      } else {
        alert("Nessun volto rilevato in questa area. Centra meglio il viso includendo occhi e naso.");
      }
    } catch (err) {
      console.error(err);
      alert("Errore durante l'elaborazione dell'immagine.");
    } finally {
      setTraining(false);
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const removePerson = (index) => {
    if (confirm(`Sicuro di voler rimuovere ${people[index].name}?`)) {
      const updated = people.filter((_, i) => i !== index);
      onPeopleUpdated(updated);
    }
  };

  const removePhoto = (personIdx, photoIdx) => {
    if (confirm(`Sicuro di voler rimuovere questa foto dall'addestramento di ${people[personIdx].name}?`)) {
      const updatedPeople = [...people];
      updatedPeople[personIdx].photos = updatedPeople[personIdx].photos.filter((_, idx) => idx !== photoIdx);
      if (updatedPeople[personIdx].descriptors) {
        updatedPeople[personIdx].descriptors = updatedPeople[personIdx].descriptors.filter((_, idx) => idx !== photoIdx);
      }
      onPeopleUpdated(updatedPeople);
    }
  };

  const addPerson = () => {
    const name = prompt('Inserisci il nome della persona:');
    if (name) {
      onPeopleUpdated([...people, { name, photos: [], descriptors: [] }]);
    }
  };

  return (
    <div className="inspector-section">
      <div className="inspector-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Libreria Riconoscimento Volti</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px', background: 'var(--success-color)', borderColor: 'var(--success-color)', color: '#fff' }} onClick={async () => {
            try {
              // The API_BASE logic isn't easily imported here if we rely on App.jsx, but we can use relative or localhost
              const res = await fetch(`http://localhost:3001/api/sync-github`, { method: 'POST' });
              const data = await res.json();
              if (data.success) {
                alert(data.message);
              } else {
                alert("Errore: " + data.error);
              }
            } catch (e) {
              alert("Impossibile connettersi al server per la sincronizzazione.");
            }
          }}>☁️ Sincronizza su GitHub</button>
          <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={addPerson}>+ Aggiungi Persona</button>
        </div>
      </div>
      
      {statusMessage && (
        <div style={{ fontSize: '12px', color: 'var(--accent-color)', marginBottom: '10px', fontWeight: '500' }}>
          {statusMessage}
        </div>
      )}
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {people.map((person, personIdx) => (
          <div key={person.name} style={{ background: 'var(--input-bg)', padding: '12px', borderRadius: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: '600' }}>{person.name}</span>
              <button 
                onClick={() => removePerson(personIdx)} 
                style={{ background: 'none', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', fontSize: '11px' }}
              >
                Rimuovi
              </button>
            </div>
            
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '8px', alignItems: 'center' }}>
              {person.photos.map((photo, photoIdx) => (
                <div 
                  key={photoIdx} 
                  style={{ 
                    position: 'relative', 
                    width: '64px', 
                    height: '64px'
                  }}
                >
                  <img 
                    src={photo} 
                    alt={person.name} 
                    style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--accent-color)' }}
                  />
                  <button
                    onClick={() => removePhoto(personIdx, photoIdx)}
                    style={{
                      position: 'absolute',
                      top: '-2px',
                      right: '-2px',
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background: 'var(--danger-color)',
                      color: '#fff',
                      border: '1.5px solid var(--input-bg)',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                      padding: 0,
                      lineHeight: 1
                    }}
                    title="Rimuovi questa foto dall'addestramento"
                  >
                    ×
                  </button>
                </div>
              ))}
              
              <label 
                style={{ 
                  width: '64px', 
                  height: '64px', 
                  borderRadius: '50%', 
                  border: '1.5px dashed var(--text-secondary)', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  cursor: 'pointer',
                  fontSize: '20px',
                  color: 'var(--text-secondary)',
                  background: 'rgba(255,255,255,0.03)'
                }}
              >
                +
                <input 
                  type="file" 
                  accept="image/*" 
                  onChange={(e) => handlePhotoSelect(personIdx, e)} 
                  style={{ display: 'none' }}
                  disabled={training}
                />
              </label>
            </div>
            
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              {person.descriptors.length} volti registrati
            </span>
          </div>
        ))}
      </div>

      {/* Cropper Modal */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '550px', width: '100%', padding: '24px' }}>
            <h3 style={{ marginTop: 0, marginBottom: '8px', fontSize: '18px', fontWeight: '600' }}>
              Seleziona il Volto
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 0, marginBottom: '16px' }}>
              Trascina il cursore sopra il viso della persona per ritagliarlo precisamente.
            </p>

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
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                style={{ cursor: 'crosshair', display: 'block' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowModal(false)}
                disabled={training}
                style={{ color: '#fff' }}
              >
                Annulla
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleConfirmCrop}
                disabled={training}
              >
                {training ? '⏳ Rilevamento...' : 'Registra Volto'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
