import React, { useState, useEffect } from 'react';

const DEFAULT_DB = {
  "Partenone": ["Partenone", "Parthenon", "Acropoli", "Acropolis", "Atene", "Athens", "Grecia", "UNESCO", "Tempio", "Atena", "Dorico", "Patrimonio mondiale", "Archeologia", "Tempio dedicato ad Atena", "V secolo a.C."],
  "Tempio di Zeus": ["Tempio di Zeus", "Temple of Olympian Zeus", "Atene", "Athens", "Grecia", "Tempio", "Zeus", "Antica Grecia", "Colonne", "Archeologia"],
  "Museo Acropoli": ["Museo Acropoli", "Acropolis Museum", "Atene", "Athens", "Grecia", "Museo", "Archeologia", "Sculture", "Marmo", "Acropoli"],
  "Evzones": ["Cambio della Guardia", "Evzones", "Syntagma", "Parlamento", "Atene", "Athens", "Grecia", "Tradizione", "Militari", "Costume tradizionale"],
  "Plaka": ["Plaka", "Atene", "Athens", "Grecia", "Quartiere storico", "Stradine", "Negozi", "Ristoranti", "Caratteristico"],
  "Licabetto": ["Licabetto", "Lycabettus", "Collina", "Panorama", "Vista dall'alto", "Atene", "Athens", "Grecia", "Tramonto"]
};

export default function LocationDbSettings({ onDbUpdated }) {
  const [db, setDb] = useState(() => {
    const saved = localStorage.getItem('travel_landmarks_db');
    return saved ? JSON.parse(saved) : DEFAULT_DB;
  });

  const [newKey, setNewKey] = useState('');
  const [newTags, setNewTags] = useState('');

  useEffect(() => {
    localStorage.setItem('travel_landmarks_db', JSON.stringify(db));
    if (onDbUpdated) onDbUpdated(db);
  }, [db]);

  const handleAdd = (e) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    const tagsArr = newTags.split(',').map(t => t.trim()).filter(Boolean);
    setDb(prev => ({
      ...prev,
      [newKey.trim()]: tagsArr
    }));
    setNewKey('');
    setNewTags('');
  };

  const handleRemove = (key) => {
    if (confirm(`Sicuro di voler rimuovere ${key}?`)) {
      const updated = { ...db };
      delete updated[key];
      setDb(updated);
    }
  };

  return (
    <div className="inspector-section">
      <div className="inspector-title">Database Luoghi & Monumenti</div>
      
      <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
        <input 
          className="form-input" 
          placeholder="Nome monumento (es. Partenone)" 
          value={newKey} 
          onChange={(e) => setNewKey(e.target.value)}
        />
        <input 
          className="form-input" 
          placeholder="Keywords associate (separate da virgola)" 
          value={newTags} 
          onChange={(e) => setNewTags(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>Aggiungi Associazione</button>
      </form>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '300px', overflowY: 'auto' }}>
        {Object.entries(db).map(([key, tags]) => (
          <div key={key} style={{ background: 'var(--input-bg)', padding: '10px', borderRadius: '8px', fontSize: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: '600', marginBottom: '4px' }}>
              <span>{key}</span>
              <button 
                onClick={() => handleRemove(key)} 
                style={{ background: 'none', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', fontSize: '10px' }}
              >
                Rimuovi
              </button>
            </div>
            <div style={{ color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {tags.map(t => (
                <span key={t} style={{ background: 'rgba(0,0,0,0.05)', padding: '1px 4px', borderRadius: '4px', fontSize: '10px' }}>{t}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
