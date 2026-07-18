import React, { useState, useEffect } from 'react';
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
  
  useEffect(() => {
    localStorage.setItem('trained_people', JSON.stringify(people));
    rebuildMatcher();
  }, [people]);

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

  const handlePhotoUpload = async (personIndex, e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    
    setTraining(true);
    setStatusMessage(`Analisi del volto per ${people[personIndex].name}...`);
    
    try {
      await loadFaceApiModels();
      const updatedPeople = [...people];
      
      for (const file of files) {
        // Read file as base64 to display and detect
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        
        // Create an image element to feed into face-api
        const img = new Image();
        img.src = base64;
        await new Promise((resolve) => (img.onload = resolve));
        
        const detection = await faceapi.detectSingleFace(img)
          .withFaceLandmarks()
          .withFaceDescriptor();
          
        if (detection) {
          updatedPeople[personIndex].photos.push(base64);
          // Convert Float32Array to regular array for localStorage JSON serialization
          updatedPeople[personIndex].descriptors.push(Array.from(detection.descriptor));
          setStatusMessage(`Volto registrato con successo!`);
        } else {
          alert(`Nessun volto rilevato nella foto per ${people[personIndex].name}. Riprova con un'immagine più chiara.`);
        }
      }
      
      setPeople(updatedPeople);
    } catch (err) {
      console.error(err);
      setStatusMessage('Errore durante l\'addestramento.');
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
        <span>Libreria Volti</span>
        <button className="btn btn-secondary" style={{ padding: '2px 8px', fontSize: '11px' }} onClick={addPerson}>+ Aggiungi</button>
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
                  multiple 
                  onChange={(e) => handlePhotoUpload(personIdx, e)} 
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
    </div>
  );
}
