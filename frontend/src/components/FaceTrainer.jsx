import React, { useState, useEffect, useRef } from 'react';
import * as faceapi from '@vladmandic/face-api';
import { loadFaceApiModels } from '../utils/faceRecognition';

export default function FaceTrainer({ onMatcherUpdated }) {
  const [people, setPeople] = useState(() => {
    const saved = localStorage.getItem('trained_people');
    return saved ? JSON.parse(saved) : [
      { name: 'Mattia', photos: [], descriptors: [] },
      { name: 'Tiziana', photos: [], descriptors: [] },
      { name: 'Samuele', photos: [], descriptors: [] }
    ];
  });
  
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

  useEffect(() => {
    localStorage.setItem('trained_people', JSON.stringify(people));
    rebuildMatcher();
  }, [people]);

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

  const rebuildMatcher = async () => {
    const activePeople = people.filter(p => p.descriptors && p.descriptors.length > 0);
    if (activePeople.length === 0) {
      onMatcherUpdated(null);
      return;
    }
    
    try {
      const labeledDescriptors = activePeople.map(p => {
        const floatDescriptors = p.descriptors.map(d => new Float32Array(d));
        return new faceapi.LabeledFaceDescriptors(p.name, floatDescriptors);
      });
      const matcher = new faceapi.FaceMatcher(labeledDescriptors, 0.55);
      onMatcherUpdated(matcher);
    } catch (err) {
      console.error('Error rebuilding face matcher:', err);
    }
  };

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
        setPeople(updatedPeople);
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
      setPeople(updated);
    }
  };

  const addPerson = () => {
    const name = prompt('Inserisci il nome della persona:');
    if (name) {
      setPeople([...people, { name, photos: [], descriptors: [] }]);
    }
  };

  return (
    <div className="inspector-section">
      <div className="inspector-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Libreria Riconoscimento Volti</span>
        <button className="btn btn-secondary" style={{ padding: '2px 8px', fontSize: '11px' }} onClick={addPerson}>+ Aggiungi Persona</button>
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
            
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
              {person.photos.map((photo, photoIdx) => (
                <img 
                  key={photoIdx} 
                  src={photo} 
                  alt={person.name} 
                  style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', border: '1.5px solid var(--accent-color)' }}
                />
              ))}
              
              <label 
                style={{ 
                  width: '40px', 
                  height: '40px', 
                  borderRadius: '50%', 
                  border: '1.5px dashed var(--text-secondary)', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  cursor: 'pointer',
                  fontSize: '16px',
                  color: 'var(--text-secondary)'
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
              Seleziona il Volto
            </h3>
            <p style={{ fontSize: '13px', color: '#aaa', marginTop: 0, marginBottom: '16px' }}>
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
