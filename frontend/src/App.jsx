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
  const cleanNames = [...new Set(names.map(n => n && n.trim()).filter(Boolean))];
  if (cleanNames.length === 0) return "";
  if (cleanNames.length === 1) return cleanNames[0];
  if (cleanNames.length === 2) return `${cleanNames[0]} e ${cleanNames[1]}`;
  return `${cleanNames.slice(0, -1).join(", ")} e ${cleanNames[cleanNames.length - 1]}`;
};

// Helper function to prevent any duplicate person names in titles and descriptions
// Helper function to prevent any duplicate person names in titles and descriptions
const cleanDuplicateNames = (text, knownNames = []) => {
  if (!text || typeof text !== "string") return text;
  let s = text.trim();

  // 1. Gather ONLY real confirmed person names (NEVER guess from repeated words, which deletes common words like 'bambino')
  const namesToCheck = new Set(
    (knownNames && knownNames.length > 0)
      ? knownNames.map(n => n && n.trim().replace(/\s*\[[MFB]\]/i, "")).filter(Boolean)
      : []
  );

  // 2. Collapse immediate repeated words with commas, "e", "ed", "-", ":" (e.g. "Mattia, Mattia e Mattia" -> "Mattia")
  let prev;
  do {
    prev = s;
    s = s.replace(/\b([A-ZÀ-ÿa-z0-9_-]+)(?:\s*(?:,|e|ed|-|:)\s+\1)+\b/gi, "$1");
  } while (s !== prev);

  // 3. Strip artificial description prefixes like "Mattia, Samuele: Una foto notturna..." -> "Una foto notturna..."
  s = s.replace(/^[A-ZÀ-ÿa-z0-9_,\s-]+(?:e|ed)?\s+[A-ZÀ-ÿa-z0-9_-]+\s*[-:]\s*(Una foto|Un |Uno |Due |Foto|Splendida|Suggestiva|In |Vista|Panoramica|Primo piano|Immagine)/i, "$1");

  // 4. Check for prefix like "Prefix Names - Rest of sentence" or "Prefix Names: Rest of sentence"
  const prefixMatch = s.match(/^([^:-]+?)\s*[-:]\s*(.+)$/i);
  if (prefixMatch) {
    const prefix = prefixMatch[1].trim();
    const rest = prefixMatch[2].trim();
    
    const prefixWords = prefix.match(/\b[A-ZÀ-ÿa-z0-9_-]{2,}\b/g) || [];
    const restLower = rest.toLowerCase();
    
    // If every significant word in prefix is already in rest, drop the prefix entirely!
    const allInRest = prefixWords.length > 0 && prefixWords.every(w => stopWords.has(w.toLowerCase()) || restLower.includes(w.toLowerCase()));
    if (allInRest) {
      s = rest;
    } else {
      let cleanPrefix = prefix;
      for (const name of namesToCheck) {
        if (!name || name.length < 2) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const restRegex = new RegExp(`\\b${escaped}\\b`, "i");
        if (restRegex.test(rest)) {
          cleanPrefix = cleanPrefix.replace(new RegExp(`(?:\\s*(?:,|e|ed)\\s+)?\\b${escaped}\\b`, "gi"), "");
        }
      }
      cleanPrefix = cleanPrefix.replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
                               .replace(/\b(e|ed)\s*$/gi, "")
                               .trim();
      if (cleanPrefix.length > 0) {
        // Strip generic subject from rest if present (e.g. "Giovane gamer" -> "gamer")
        const genericRest = rest.replace(/^(?:Un |Una |Il |La )?(?:giovane|ragazzo|ragazza|bambino|bambina|persona|uomo|donna)\s+/i, "");
        if (genericRest !== rest) {
          s = `${cleanPrefix} ${genericRest}`;
        } else {
          s = `${cleanPrefix} ${rest.charAt(0).toLowerCase() + rest.slice(1)}`;
        }
      } else {
        s = rest;
      }
    }
  }

  // 5. For every name in namesToCheck, enforce strictly AT MOST 1 occurrence in the entire text
  for (const name of namesToCheck) {
    if (!name || name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "gi");
    const matches = s.match(regex);
    if (!matches || matches.length <= 1) continue;

    let seen = 0;
    const subRegex = new RegExp(`(?:\\s*(?:,|e|ed|con)\\s+)?\\b${escaped}\\b`, "gi");
    s = s.replace(subRegex, (match) => {
      seen++;
      if (seen === 1) return match;
      return "";
    });
  }

  // 6. Polish commas between two names to "e" (e.g. "Samuele, Mattia in piazza" -> "Samuele e Mattia in piazza")
  s = s.replace(/\b([A-ZÀ-ÿa-z0-9_-]+),\s+([A-ZÀ-ÿa-z0-9_-]+)\b(?!\s*,)/g, "$1 e $2");

  // 7. Polish punctuation, conjunctions, and whitespace
  s = s.replace(/\s*,\s*e\b/gi, " e")
       .replace(/\be\s+e\b/gi, "e")
       .replace(/\s*[-:]\s*[-:]\s*/g, " - ")
       .replace(/^[-:,\s]+/, "")
       .replace(/[-:,\s]+$/, "")
       .replace(/\s{2,}/g, " ")
       .trim();

  // Polish dangling prepositions at end of sentences
  s = s.replace(/\s+\b(con|e|ed|in|su|tra|fra|di|a|da)\s*([.,;!?]?)$/gi, "$2").trim();

  // 8. Fix common Italian grammar artifacts produced by AI
  // Replace orphan articles before verbs (e.g. "Il indossa..." -> "Indossa...", "Il è..." -> "È...")
  s = s.replace(/\b([I|i]l|[L|l]a|[L|l]o|[I|i]|[G|g]li|[L|l]e)\s+(indossa|porta|guarda|è|ha|siede|sta|sembra|gioca|appare|trova)\b/g, (match, art, verb) => {
    return art[0] === art[0].toUpperCase() ? verb.charAt(0).toUpperCase() + verb.slice(1) : verb;
  });
  // Replace orphan "Il in..." -> "In..."
  s = s.replace(/\b([I|i]l|[L|l]a|[L|l]o)\s+(in|su|a|con|durante)\b/g, (match, art, prep) => {
    return art[0] === art[0].toUpperCase() ? prep.charAt(0).toUpperCase() + prep.slice(1) : prep;
  });
  // Replace "Nome e un bambino" -> "Nome è un bambino"
  s = s.replace(/\b([A-ZÀ-ÿa-z0-9_-]+)\s+e\s+(un|una|uno)\b/g, "$1 è $2");
  // Replace English calque "attentivo" -> "attento"
  s = s.replace(/\battentiv([oaie])\b/gi, "attent$1");
  // Clean chains of " e con " -> ", con "
  s = s.replace(/\s+e\s+con\s+/gi, ", con ");

  return s;
};

export const applyItalianGenderConcordance = (text, oldName, newName, oldGender, newGender) => {
  if (!text) return text;
  let res = text;

  // 1. Sostituzione del nome con boundary
  if (oldName && oldName.toLowerCase() !== 'sconosciuto' && oldName.toLowerCase() !== 'unknown') {
    const escOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    res = res.replace(new RegExp(`\\b${escOld}\\b`, 'gi'), newName);
  }

  // 2. Concordanza grammaticale di genere (Femminile -> Maschile)
  if (oldGender === 'F' && newGender === 'M') {
    const fToM = [
      [/\b(è|era|sembra|appare)\s+seduta\b/gi, '$1 seduto'],
      [/\bseduta\b/gi, 'seduto'],
      [/\bsdraiata\b/gi, 'sdraiato'],
      [/\bdistesa\b/gi, 'disteso'],
      [/\bcoricata\b/gi, 'coricato'],
      [/\bvestita\b/gi, 'vestito'],
      [/\bimpegnata\b/gi, 'impegnato'],
      [/\bconcentrata\b/gi, 'concentrato'],
      [/\battenta\b/gi, 'attento'],
      [/\bferma\b/gi, 'fermo'],
      [/\bgirata\b/gi, 'girato'],
      [/\bvoltata\b/gi, 'voltato'],
      [/\bsola\b/gi, 'solo'],
      [/\britratta\b/gi, 'ritratto'],
      [/\bfotografata\b/gi, 'fotografato'],
      [/\bimmortalata\b/gi, 'immortalato'],
      [/\bripresa\b/gi, 'ripreso'],
      [/\binquadrata\b/gi, 'inquadrato'],
      [/\bvista\b/gi, 'visto'],
      [/\baccompagnata\b/gi, 'accompagnato'],
      [/\bcircondata\b/gi, 'circondato'],
      [/\bpronta\b/gi, 'pronto'],
      [/\bcuriosa\b/gi, 'curioso'],
      [/\bdivertita\b/gi, 'divertito'],
      [/\bappassionata\b/gi, 'appassionato'],
      [/\bragazza\b/gi, 'ragazzo'],
      [/\bdonna\b/gi, 'uomo'],
      [/\bbambina\b/gi, 'bambino'],
      [/\buna\s+giovane\b/gi, 'un giovane'],
      [/\buna\s+bambina\b/gi, 'un bambino'],
      [/\buna\s+ragazza\b/gi, 'un ragazzo'],
      [/\bdella\s+ragazza\b/gi, 'del ragazzo'],
      [/\bdella\s+bambina\b/gi, 'del bambino'],
      [/\bdalla\s+ragazza\b/gi, 'dal ragazzo'],
      [/\balla\s+ragazza\b/gi, 'al ragazzo']
    ];
    for (const [regex, rep] of fToM) {
      res = res.replace(regex, rep);
    }
  } else if (oldGender === 'M' && newGender === 'F') {
    const mToF = [
      [/\b(è|era|sembra|appare)\s+seduto\b/gi, '$1 seduta'],
      [/\bseduto\b/gi, 'seduta'],
      [/\bsdraiato\b/gi, 'sdraiata'],
      [/\bdisteso\b/gi, 'distesa'],
      [/\bcoricato\b/gi, 'coricata'],
      [/\bvestito\b/gi, 'vestita'],
      [/\bimpegnato\b/gi, 'impegnata'],
      [/\bconcentrato\b/gi, 'concentrata'],
      [/\battento\b/gi, 'attenta'],
      [/\bfermo\b/gi, 'ferma'],
      [/\bgirato\b/gi, 'girata'],
      [/\bvoltato\b/gi, 'voltata'],
      [/\bsolo\b/gi, 'sola'],
      [/\britratto\b/gi, 'ritratta'],
      [/\bfotografato\b/gi, 'fotografata'],
      [/\bimmortalato\b/gi, 'immortalata'],
      [/\bripreso\b/gi, 'ripresa'],
      [/\binquadrato\b/gi, 'inquadrata'],
      [/\bvisto\b/gi, 'vista'],
      [/\baccompagnato\b/gi, 'accompagnata'],
      [/\bcircondato\b/gi, 'circondata'],
      [/\bpronto\b/gi, 'pronta'],
      [/\bcurioso\b/gi, 'curiosa'],
      [/\bdivertito\b/gi, 'divertita'],
      [/\bappassionato\b/gi, 'appassionata'],
      [/\bragazzo\b/gi, 'ragazza'],
      [/\buomo\b/gi, 'donna'],
      [/\bbambino\b/gi, 'bambina'],
      [/\bun\s+giovane\b/gi, 'una giovane'],
      [/\bun\s+bambino\b/gi, 'una bambina'],
      [/\bun\s+ragazzo\b/gi, 'una ragazza'],
      [/\bdel\s+ragazzo\b/gi, 'della ragazza'],
      [/\bdel\s+bambino\b/gi, 'della bambina'],
      [/\bdal\s+ragazzo\b/gi, 'dalla ragazza'],
      [/\bal\s+ragazzo\b/gi, 'alla ragazza']
    ];
    for (const [regex, rep] of mToF) {
      res = res.replace(regex, rep);
    }
  }

  return res;
};


const removeDescriptorFromPerson = (personList, personName, faceDescriptor) => {
  if (!faceDescriptor || !personName || typeof personName !== 'string' || personName.toLowerCase() === 'sconosciuto' || personName.toLowerCase() === 'unknown') return personList;
  const targetPersonIdx = personList.findIndex(p => p && p.name && p.name.toLowerCase() === personName.toLowerCase());
  if (targetPersonIdx === -1) return personList;
  
  const targetPerson = personList[targetPersonIdx];
  if (!targetPerson || !Array.isArray(targetPerson.descriptors)) return personList;

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
    updatedPerson.descriptors = [...(targetPerson.descriptors || [])];
    updatedPerson.photos = [...(targetPerson.photos || [])];
    
    updatedPerson.descriptors.splice(matchIdx, 1);
    if (updatedPerson.photos.length > matchIdx) {
      updatedPerson.photos.splice(matchIdx, 1);
    }
    
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

  const [customInstruction, setCustomInstruction] = useState(() => localStorage.getItem('custom_ai_instruction') || '');
  useEffect(() => { localStorage.setItem('custom_ai_instruction', customInstruction); }, [customInstruction]);

  const parseStoredEventPersons = (stored) => {
    if (!Array.isArray(stored)) return [];
    return stored.map(item => {
      if (typeof item === 'object' && item !== null && item.name) {
        return {
          name: item.name.replace(/\s*\[[MFB]\]/i, '').trim(),
          gender: item.gender === 'F' ? 'F' : 'M'
        };
      }
      if (typeof item === 'string') {
        const isF = /\[F\]/i.test(item);
        const clean = item.replace(/\s*\[[MFB]\]/i, '').trim();
        return { name: clean, gender: isF ? 'F' : 'M' };
      }
      return null;
    }).filter(Boolean);
  };

  const [eventPersons, setEventPersons] = useState(() => {
    try { 
      const raw = JSON.parse(localStorage.getItem('event_persons')) || [];
      return parseStoredEventPersons(raw);
    } catch(e) { return []; }
  });
  const [newEventPerson, setNewEventPerson] = useState('');
  useEffect(() => { localStorage.setItem('event_persons', JSON.stringify(eventPersons)); }, [eventPersons]);

  // AI Engines Settings
  const [aiEngine, setAiEngine] = useState(() => localStorage.getItem('ai_engine') || 'gemini');
  useEffect(() => { localStorage.setItem('ai_engine', aiEngine); }, [aiEngine]);

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  useEffect(() => { localStorage.setItem('gemini_api_key', apiKey); }, [apiKey]);

  const [ollamaUrl, setOllamaUrl] = useState(() => localStorage.getItem('ollama_url') || 'http://localhost:11434');
  useEffect(() => { localStorage.setItem('ollama_url', ollamaUrl); }, [ollamaUrl]);

  const [selectedOllamaModels, setSelectedOllamaModels] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('selected_ollama_models'));
      // Filter out moondream if saved, since it hallucinates fixed text
      if (Array.isArray(saved) && saved.length > 0) {
        const safe = saved.filter(m => !m.includes('moondream'));
        if (safe.length > 0) return safe;
      }
    } catch(e) {}
    return ['llava:latest'];
  });
  useEffect(() => {
    localStorage.setItem('selected_ollama_models', JSON.stringify(selectedOllamaModels));
  }, [selectedOllamaModels]);

  // Thumbnail zoom slider state (110px to 340px)
  const [thumbnailSize, setThumbnailSize] = useState(() => {
    const saved = Number(localStorage.getItem('thumbnail_size'));
    return saved >= 100 && saved <= 360 ? saved : 180;
  });
  useEffect(() => {
    localStorage.setItem('thumbnail_size', thumbnailSize.toString());
  }, [thumbnailSize]);

  const [ollamaModels, setOllamaModels] = useState([]);
  const [ollamaConnected, setOllamaConnected] = useState(false);
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [isImportingModel, setIsImportingModel] = useState(false);

  const [customCloudProvider, setCustomCloudProvider] = useState(() => localStorage.getItem('custom_cloud_provider') || 'openai');
  useEffect(() => { localStorage.setItem('custom_cloud_provider', customCloudProvider); }, [customCloudProvider]);

  const [customCloudKey, setCustomCloudKey] = useState(() => localStorage.getItem('custom_cloud_key') || '');
  useEffect(() => { localStorage.setItem('custom_cloud_key', customCloudKey); }, [customCloudKey]);

  const [customCloudModel, setCustomCloudModel] = useState(() => {
    const saved = localStorage.getItem('custom_cloud_model') || '';
    if (!saved || saved.includes('meta-llama/llama-3.2-11b-vision-instruct:free') || saved.includes('google/gemma-4')) {
      return 'nvidia/nemotron-3.5-super-vl:free';
    }
    return saved;
  });
  useEffect(() => { localStorage.setItem('custom_cloud_model', customCloudModel); }, [customCloudModel]);

  const [openrouterModels, setOpenrouterModels] = useState([
    { id: "nvidia/nemotron-3.5-super-vl:free", name: "NVIDIA: Nemotron 3.5 Super VL (Consigliato)" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "NVIDIA: Nemotron 3 Nano Omni" },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots Studio: Dots3-Note Preview" }
  ]);

  useEffect(() => {
    const loadOpenRouterModels = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/openrouter-free-models`);
        const data = await res.json();
        if (data.success && Array.isArray(data.models) && data.models.length > 0) {
          setOpenrouterModels(data.models);
        }
      } catch (err) {
        console.warn("Impossibile caricare modelli OpenRouter online:", err);
      }
    };
    loadOpenRouterModels();
  }, []);

  const [expandedEngine, setExpandedEngine] = useState(() => localStorage.getItem('ai_engine') || 'gemini');

  const [customCloudConnected, setCustomCloudConnected] = useState(false);

  const geminiConnected = apiKey.trim().length >= 30;

  const checkProvidersStatus = async () => {
    setOllamaChecking(true);
    try {
      const res = await fetch(`${API_BASE}/api/check-providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          ollamaUrl,
          customCloudKey,
          customCloudProvider
        })
      });
      if (res.ok) {
        const data = await res.json();
        setOllamaConnected(data.ollama.connected);
        if (data.ollama.models && data.ollama.models.length > 0) {
          // Exclude moondream — too small (1.8B), hallucinates badly
          const usableModels = data.ollama.models.filter(m => !m.includes('moondream'));
          setOllamaModels(usableModels.length > 0 ? usableModels : data.ollama.models);
          setSelectedOllamaModels(prev => {
            const safeModels = usableModels.length > 0 ? usableModels : data.ollama.models;
            const valid = prev.filter(m => safeModels.includes(m) && !m.includes('moondream'));
            return valid.length > 0 ? valid : (safeModels.includes('llava:latest') ? ['llava:latest'] : [safeModels[0]]);
          });
        }
        setCustomCloudConnected(data.customCloud?.connected || false);
      }
    } catch (e) {
      console.warn("Could not check providers status:", e);
    } finally {
      setOllamaChecking(false);
    }
  };

  const handleImportLocalModel = async () => {
    try {
      setIsImportingModel(true);
      const resPick = await fetch(`${API_BASE}/api/pick-folder`);
      const dataPick = await resPick.json();
      if (!dataPick.success || !dataPick.path) {
        setIsImportingModel(false);
        return;
      }
      showToast(`Caricamento modello dalla cartella ${dataPick.path}...`, 'info');
      const resImport = await fetch(`${API_BASE}/api/import-local-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: dataPick.path })
      });
      const dataImport = await resImport.json();
      if (dataImport.success) {
        showToast(dataImport.message || `Modello ${dataImport.modelName} caricato con successo!`, 'success');
        await checkProvidersStatus();
      } else {
        showToast(dataImport.error || 'Errore durante il caricamento del modello.', 'error');
      }
    } catch (err) {
      showToast(`Errore: ${err.message}`, 'error');
    } finally {
      setIsImportingModel(false);
    }
  };

  useEffect(() => {
    checkProvidersStatus();
    const interval = setInterval(checkProvidersStatus, 10000);
    return () => clearInterval(interval);
  }, [apiKey, ollamaUrl, customCloudKey, customCloudProvider]);

  // Modals & Settings
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
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

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar_width');
    return saved ? parseInt(saved, 10) : 320;
  });
  const isResizingSidebar = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isResizing.current) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= 220 && newWidth <= 850) {
          setInspectorWidth(newWidth);
          try { localStorage.setItem('inspector_width', newWidth); } catch (err) {}
        }
      } else if (isResizingSidebar.current) {
        const newWidth = e.clientX;
        if (newWidth >= 200 && newWidth <= 700) {
          setSidebarWidth(newWidth);
          try { localStorage.setItem('sidebar_width', newWidth); } catch (err) {}
        }
      }
    };
    const handleMouseUp = () => {
      if (isResizing.current || isResizingSidebar.current) {
        isResizing.current = false;
        isResizingSidebar.current = false;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Heartbeat sender to keep local server alive
  useEffect(() => {
    const sendHeartbeat = () => {
      fetch(`${API_BASE}/api/heartbeat`, { method: 'POST' }).catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 3000);
    return () => clearInterval(interval);
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
    rebuildMatcher(newList);
    
    // Filter out temporary event persons before saving permanently
    const persistentPeople = newList.filter(p => !eventPersons.some(ep => ep.name === p.name));
    try {
      localStorage.setItem('trained_people', JSON.stringify(persistentPeople));
    } catch (e) {
      console.warn("Could not save trained_people to localStorage:", e);
    }
    try {
      await savePeopleToBackend(persistentPeople);
    } catch (e) {
      console.warn("Could not save trained_people to backend:", e);
    }
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
    if (!img) return img;
    
    // If metadata already loaded, verify title and description are clean of duplicates
    if (img.metadata !== null) {
      const allNames = (people || []).map(p => p.name);
      const cleanT = cleanDuplicateNames(img.metadata.title, allNames);
      const cleanD = cleanDuplicateNames(img.metadata.description, allNames);
      if (cleanT !== img.metadata.title || cleanD !== img.metadata.description) {
        const cleaned = {
          ...img,
          metadata: {
            ...img.metadata,
            title: cleanT,
            description: cleanD
          }
        };
        setImages(prev => prev.map(i => i.path === img.path ? cleaned : i));
        if (selectedImage && selectedImage.path === img.path) {
          setSelectedImage(cleaned);
        }
        return cleaned;
      }
      return img;
    }
    
    try {
      const response = await fetch(`${API_BASE}/api/image-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: img.path })
      });
      const data = await response.json();
      if (data.success) {
        const allNames = (people || []).map(p => p.name);
        const meta = {
          ...data.metadata,
          title: cleanDuplicateNames(data.metadata?.title || "", allNames),
          description: cleanDuplicateNames(data.metadata?.description || "", allNames)
        };
        const updated = { ...img, metadata: meta, analyzed: data.analyzed };
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
  const analyzeImage = async (img, onStatusUpdate = null) => {
    try {
      if (onStatusUpdate) onStatusUpdate("Rilevamento volti con face-api...");
      // 1. Run local face-api.js detection in browser with a 6-second timeout race
      let detectedFaces = [];
      try {
        const imageSrc = `${API_BASE}/api/image?path=${encodeURIComponent(img.path)}&size=preview`;
        detectedFaces = await Promise.race([
          detectAndMatchFaces(imageSrc, faceMatcher),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout face-api")), 6000))
        ]);
      } catch (faceErr) {
        console.warn("Face-api.js avviso non critico:", faceErr.message);
      }

      if (onStatusUpdate) onStatusUpdate("Preparazione anteprima ottimizzata...");
      // Downsample the image to send to backend with a 5-second timeout race
      let base64Image = null;
      try {
        base64Image = await Promise.race([
          downsampleImage(img.path),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout downsample")), 5000))
        ]);
      } catch (downsampleErr) {
        console.warn("Downsample browser non critico, invio path diretto:", downsampleErr.message);
      }

      // 2. Query Vision API
      let data = null;
      let retries = 3;

      if (processing && aiEngine === 'gemini') {
        if (onStatusUpdate) onStatusUpdate("Attesa anti-quota Gemini (4s)...");
        await new Promise(resolve => setTimeout(resolve, 4000));
      }

      if (onStatusUpdate) {
        if (aiEngine === 'ollama') {
          const mList = selectedOllamaModels.length > 0 ? selectedOllamaModels.join(' + ') : 'Ollama';
          onStatusUpdate(`Inferenza locale (${mList})... attendi ~15-35s`);
        } else if (aiEngine === 'gemini') {
          onStatusUpdate("Analisi Google Gemini Cloud in corso...");
        } else {
          onStatusUpdate("Generazione tag offline in corso...");
        }
      }

      // Collect recognized people from detected faces, PLUS any trained people already in the photo keywords
      const faceNames = detectedFaces
        .filter(f => f.name && f.name.toLowerCase() !== 'sconosciuto' && f.name.toLowerCase() !== 'unknown')
        .map(f => f.name.trim());
      
      const existingKeywordPeople = (img.metadata?.keywords || [])
        .filter(k => (people || []).some(p => p.name.toLowerCase() === k.toLowerCase()));
      
      const rawPeople = [...new Set([...faceNames, ...existingKeywordPeople].filter(Boolean))];
      const peopleForGemini = rawPeople.map(pName => {
        const clean = pName.replace(/\s*\[[MFB]\]/i, '').trim();
        const matchedEventPerson = eventPersons.find(ep => ep.name.toLowerCase() === clean.toLowerCase());
        if (matchedEventPerson) {
          return `${matchedEventPerson.name} [${matchedEventPerson.gender}]`;
        }
        return pName;
      });

      while (retries > 0) {
        try {
          const activeAuthToken = aiEngine === 'gemini' 
            ? apiKey.trim() 
            : (aiEngine === 'customCloud' ? customCloudKey.trim() : undefined);

          const response = await fetch(`${API_BASE}/api/analyze-gemini`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              ...(activeAuthToken ? { 'Authorization': `Bearer ${activeAuthToken}` } : {})
            },
            body: JSON.stringify({
              filePath: base64Image ? undefined : img.path,
              base64Image: base64Image ? base64Image.split(',')[1] : undefined,
              landmarksDb,
              detectedPeople: peopleForGemini,
              globalTags,
              customInstruction: customInstruction.trim() || undefined,
              provider: aiEngine === 'customCloud' ? customCloudProvider : aiEngine,
              customCloudKey: customCloudKey.trim() || undefined,
              cloudModel: customCloudModel.trim() || undefined,
              ollamaUrl,
              ollamaModels: selectedOllamaModels,
              ollamaModel: selectedOllamaModels[0] || 'llava:latest'
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
              if (onStatusUpdate) onStatusUpdate(`Quota superata. Attesa di ${w}s prima di riprovare...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            continue;
          } else {
            throw fetchErr;
          }
        }
      }

      if (!data) throw new Error("Risposta vuota o errore dal server di analisi.");
      const analysis = data.analysis;

      if (onStatusUpdate) onStatusUpdate("Composizione metadati e parole chiave...");

      // 3. Combine analysis
      const finalKeywords = new Set([
        ...(analysis.suggestedKeywords || []),
        ...(analysis.landmarks || []),
        ...(analysis.objects || []),
        ...(analysis.events ? [analysis.events] : []),
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

      // Ensure recognized faces are in the title and description without duplicates
      const recognizedNames = [...new Set(
        detectedFaces
          .filter(f => f.name && f.name.toLowerCase() !== 'sconosciuto' && f.name.toLowerCase() !== 'unknown')
          .map(f => f.name.trim())
          .filter(Boolean)
      )];

      const allKnownPersonNames = [...new Set([...recognizedNames, ...people.map(p => p.name)])];

      // Use fresh analysis from Gemini
      let finalTitle = analysis.title || img.name;
      let finalDescription = analysis.description || '';

      // If recognized faces were found, integrate them naturally into title and description (NO DASHES)
      if (recognizedNames.length > 0) {
        const namesFormatted = formatNamesItalian(recognizedNames);
        const hasAnyPersonInTitle = recognizedNames.some(name => finalTitle.toLowerCase().includes(name.toLowerCase()));
        
        if (!hasAnyPersonInTitle) {
          let cleanT = finalTitle.trim();
          // Replace generic words like "Giovane gamer", "Un ragazzo", "Bambino" directly with the person name
          const genericPattern = /^(?:Un |Una |Il |La )?(?:giovane|ragazzo|ragazza|bambino|bambina|persona|uomo|donna|individuo)\b/i;
          const genericPlural = /^(?:Due|Tre|Quattro|\d+)?\s*(?:giovani|ragazzi|ragazze|bambini|bambine|persone|uomini|donne)\b/i;
          
          if (genericPattern.test(cleanT)) {
            finalTitle = cleanT.replace(genericPattern, namesFormatted).trim();
          } else if (genericPlural.test(cleanT)) {
            finalTitle = cleanT.replace(genericPlural, namesFormatted).trim();
          } else if (/^(?:Ritratto|Foto|Scatto|Primo piano)\s+(?:di|con)\s+(?:un|una|uno|dei|delle)?\s*(?:persona|ragazzo|ragazza|bambino|bambina|uomo|donna)?/i.test(cleanT)) {
            finalTitle = cleanT.replace(/^(Ritratto|Foto|Scatto|Primo piano)\s+(?:di|con).*$/i, `$1 con ${namesFormatted}`).trim();
          } else if (/^(?:al|allo|alla|ai|agli|alle|in|sul|sulla|sullo|sui|sugli|sulle|mentre|giocando|sedut[oaie]|in piedi)\b/i.test(cleanT)) {
            finalTitle = `${namesFormatted} ${cleanT.charAt(0).toLowerCase() + cleanT.slice(1)}`;
          } else {
            // Natural integration without dash: e.g. "Gamer in casa" -> "Tiziana gamer in casa"
            finalTitle = `${namesFormatted} ${cleanT.charAt(0).toLowerCase() + cleanT.slice(1)}`;
          }
        }

        // Also integrate into description if it starts with generic subject (e.g. "Giovane gamer in casa..." -> "Tiziana gamer in casa...")
        const hasAnyPersonInDesc = recognizedNames.some(name => finalDescription.toLowerCase().includes(name.toLowerCase()));
        if (!hasAnyPersonInDesc && finalDescription) {
          const genericDescPat = /^(?:Un |Una |Il |La )?(?:giovane|ragazzo|ragazza|bambino|bambina|persona|uomo|donna)\b/i;
          if (genericDescPat.test(finalDescription.trim())) {
            finalDescription = finalDescription.trim().replace(genericDescPat, namesFormatted).trim();
          }
        }
      }

      finalTitle = cleanDuplicateNames(finalTitle, allKnownPersonNames);
      finalDescription = cleanDuplicateNames(finalDescription, allKnownPersonNames);

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
      console.error(`Errore durante analisi di ${img.name}:`, err);
      showToast(`Errore su ${img.name}: ${err.message}`, "error");
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
    setProgress(1); // Set to 1% immediately so the user sees immediate activation
    
    try {
      const updatedImages = [...images];
      
      for (let i = 0; i < targetImages.length; i++) {
        const targetImg = targetImages[i];
        const mainIdx = updatedImages.findIndex(img => img.path === targetImg.path);
        if (mainIdx === -1) continue;

        const img = updatedImages[mainIdx];
        if (!onlySelected && !forceAll && img.analyzed) {
          setProgress(Math.round(((i + 1) / targetImages.length) * 100));
          continue;
        }

        const basePct = Math.round((i / targetImages.length) * 100);
        const nextPct = Math.round(((i + 1) / targetImages.length) * 100);
        const chunk = Math.max(3, nextPct - basePct);

        setCurrentProcessingName(`[${i + 1}/${targetImages.length}] ${img.name}: Avvio analisi...`);
        setProgress(Math.min(99, basePct + Math.round(chunk * 0.1)));

        // Live ticker to advance progress bar smoothly while model is processing
        let subFraction = 0.15;
        const subTicker = setInterval(() => {
          if (subFraction < 0.85) {
            subFraction += 0.08;
            setProgress(Math.min(99, basePct + Math.round(chunk * subFraction)));
          }
        }, 2500);

        let newMeta = null;
        try {
          newMeta = await analyzeImage(img, (statusText) => {
            setCurrentProcessingName(`[${i + 1}/${targetImages.length}] ${img.name}: ${statusText}`);
          });
        } finally {
          clearInterval(subTicker);
        }

        if (newMeta) {
          updatedImages[mainIdx] = {
            ...img,
            metadata: newMeta,
            analyzed: true,
            isNew: true
          };
          setImages([...updatedImages]);
          if (selectedImage && selectedImage.path === img.path) {
            setSelectedImage(updatedImages[mainIdx]);
          }
        }
        
        setProgress(nextPct);
      }
      
      showToast("Analisi batch completata!");
      if (onlySelected) {
        clearImageSelection();
      }
    } finally {
      setProcessing(false);
      setCurrentProcessingName('');
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
    
    try {
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
        
        if (selectedImage && pathsSuccessfullySaved.includes(selectedImage.path)) {
          setSelectedImage(prev => ({...prev, isNew: false}));
        }
      }
      
      if (anyTrainingUpdates) {
        await updatePeopleList(currentPeopleList);
        showToast("Volti salvati nel database per il riconoscimento futuro!", "success");
      }

      showToast(`Salvataggio completato per ${successCount} di ${toSave.length} immagini.`);
      if (onlySelected) {
        clearImageSelection();
      }
    } finally {
      setProcessing(false);
      setCurrentProcessingName('');
      setProgress(0);
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
    
    const trainedPeopleList = people.length > 0 ? people : [
      { name: 'Mattia', photos: [], descriptors: [] },
      { name: 'Tiziana', photos: [], descriptors: [] },
      { name: 'Samuele', photos: [], descriptors: [] }
    ];
    
    setManualCropImage(imageSrc);
    setSelectedPersonForCrop(eventPersons.length > 0 ? eventPersons[0].name : (trainedPeopleList[0]?.name || 'Mattia'));
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

      // Trova genere vecchio e nuovo per la concordanza grammaticale automatica
      const getPersonGender = (pName) => {
        if (!pName) return 'M';
        const clean = pName.toLowerCase().trim();
        const foundEp = eventPersons.find(p => p.name.toLowerCase().trim() === clean);
        if (foundEp && foundEp.gender) return foundEp.gender;
        const foundP = people.find(p => p.name.toLowerCase().trim() === clean);
        if (foundP && foundP.gender) return foundP.gender;
        if (clean.endsWith('a') && !['andrea', 'luca', 'mattia', 'nicola', 'elia'].includes(clean)) return 'F';
        return 'M';
      };

      const oldGender = getPersonGender(oldName);
      const newGender = getPersonGender(name);

      let currentTitle = updatedMeta.title || "";
      let currentDesc = updatedMeta.description || "";

      // Concordanza immediata in italiano (seduta -> seduto o viceversa)
      if (oldName && oldName.toLowerCase() !== 'sconosciuto' && oldName.toLowerCase() !== 'unknown') {
        currentTitle = applyItalianGenderConcordance(currentTitle, oldName, name, oldGender, newGender);
        currentDesc = applyItalianGenderConcordance(currentDesc, oldName, name, oldGender, newGender);
      } else {
        if (!currentTitle.toLowerCase().includes(name.toLowerCase())) {
          currentTitle = `${name} ${currentTitle.charAt(0).toLowerCase() + currentTitle.slice(1)}`;
        }
        currentTitle = applyItalianGenderConcordance(currentTitle, null, name, oldGender, newGender);
        currentDesc = applyItalianGenderConcordance(currentDesc, null, name, oldGender, newGender);
      }

      updatedMeta.title = cleanDuplicateNames(currentTitle, [name, oldName]);
      updatedMeta.description = cleanDuplicateNames(currentDesc, [name, oldName]);

      // Aggiorna le parole chiave rimuovendo Sconosciuto/oldName e aggiungendo il nuovo nome
      const kwSet = new Set(
        (updatedMeta.keywords || []).filter(k => 
          k.toLowerCase() !== 'sconosciuto' && 
          k.toLowerCase() !== 'unknown' && 
          (!oldName || k.toLowerCase() !== oldName.toLowerCase())
        )
      );
      if (name && name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown') {
        kwSet.add(name);
      }
      updatedMeta.keywords = Array.from(kwSet);

      // Aggiorna istantaneamente l'interfaccia a schermo!
      const instantImg = {
        ...selectedImage,
        metadata: updatedMeta,
        analyzed: true
      };
      setSelectedImage(instantImg);
      setImages(images.map(img => img.path === selectedImage.path ? instantImg : img));

      setAnalyzingSingle(true);
      try {
        let instruction = "";
        const wasUnknown = (!oldName || oldName.toLowerCase() === 'sconosciuto' || oldName.toLowerCase() === 'unknown');
        if (wasUnknown) {
           instruction = `Aggiungi la persona chiamata "${name}" (${newGender === 'F' ? 'donna' : 'uomo'}) alla frase. Integra la persona nel contesto e concorda il genere (es. seduto/seduta, ragazzo/ragazza). Non lasciare frasi a metà.`;
        } else {
           instruction = `Sostituisci la persona chiamata "${oldName}" (${oldGender === 'F' ? 'donna' : 'uomo'}) con "${name}" (${newGender === 'F' ? 'donna' : 'uomo'}). Correggi con estrema attenzione tutte le concordanze di genere (es. da seduta a seduto o viceversa) e di numero. Mantieni il contesto identico.`;
        }

        const activeAuthToken = aiEngine === 'gemini' 
          ? apiKey.trim() 
          : (aiEngine === 'customCloud' ? customCloudKey.trim() : undefined);

        const response = await fetch(`${API_BASE}/api/rewrite-text`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            ...(activeAuthToken ? { 'Authorization': `Bearer ${activeAuthToken}` } : {})
          },
          body: JSON.stringify({
            title: updatedMeta.title,
            description: updatedMeta.description,
            instruction: instruction,
            provider: aiEngine === 'customCloud' ? customCloudProvider : aiEngine,
            customCloudKey: customCloudKey.trim() || undefined,
            cloudModel: customCloudModel.trim() || undefined,
            ollamaUrl,
            ollamaModels: selectedOllamaModels,
            ollamaModel: selectedOllamaModels[0] || 'llava:latest'
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          const rewrittenTitle = data.title || updatedMeta.title;
          const rewrittenDesc = data.description || updatedMeta.description;
          updatedMeta.title = cleanDuplicateNames(rewrittenTitle, [name, oldName]);
          updatedMeta.description = cleanDuplicateNames(rewrittenDesc, [name, oldName]);
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
    if (!selectedImage || !selectedImage.metadata || !Array.isArray(selectedImage.metadata.faces)) return;

    try {
      const updatedMeta = { ...selectedImage.metadata };
      const facesList = [...(updatedMeta.faces || [])];
      
      const removedFace = facesList[faceIndex];
      if (!removedFace) return;
      facesList.splice(faceIndex, 1);

      const rawName = removedFace.name || "";
      const name = typeof rawName === 'string' ? rawName.trim() : "";

      updatedMeta.faces = facesList;

      // 1. Remove name from keywords if no longer present in remaining faces
      const nameStillExists = Boolean(name) && facesList.some(f => f && f.name && f.name.trim().toLowerCase() === name.toLowerCase());
      if (name && !nameStillExists && name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown') {
        const keywordsList = [...(updatedMeta.keywords || [])];
        updatedMeta.keywords = keywordsList.filter(k => k && typeof k === 'string' && k.trim().toLowerCase() !== name.toLowerCase());
      }

      // 2. Clean name from title & description locally first (fast & reliable)
      if (name && !nameStillExists && name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown') {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nameRegexComma = new RegExp(`\\s*(?:,\\s*)?${escapedName}\\s*(?:e\\s+|ed\\s+|,\\s*)?`, 'gi');
        const nameRegexEnd = new RegExp(`\\s*(?:e\\s+|ed\\s+)?${escapedName}\\b`, 'gi');
        
        let fastTitle = (updatedMeta.title || "").replace(nameRegexComma, ' ').replace(nameRegexEnd, '').replace(/\s{2,}/g, ' ').trim();
        let fastDesc = (updatedMeta.description || "").replace(nameRegexComma, ' ').replace(nameRegexEnd, '').replace(/\s{2,}/g, ' ').trim();
        
        fastTitle = fastTitle.replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim();
        fastDesc = fastDesc.replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim();

        updatedMeta.title = cleanDuplicateNames(fastTitle, [name]);
        updatedMeta.description = cleanDuplicateNames(fastDesc, [name]);
      }

      // 3. Immediately reflect in UI state so the face disappears with zero lag
      const instantImage = {
        ...selectedImage,
        metadata: { ...updatedMeta },
        analyzed: true
      };
      setSelectedImage(instantImage);
      setImages(prev => prev.map(img => img.path === selectedImage.path ? instantImage : img));

      // 4. If name was removed and AI is available, polish grammar in background
      if (name && !nameStillExists && name.toLowerCase() !== 'sconosciuto' && name.toLowerCase() !== 'unknown') {
        setAnalyzingSingle(true);
        try {
          const activeAuthToken = aiEngine === 'gemini' 
            ? apiKey.trim() 
            : (aiEngine === 'customCloud' ? customCloudKey.trim() : undefined);

          const response = await fetch(`${API_BASE}/api/rewrite-text`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              ...(activeAuthToken ? { 'Authorization': `Bearer ${activeAuthToken}` } : {})
            },
            body: JSON.stringify({
              title: updatedMeta.title || "",
              description: updatedMeta.description || "",
              instruction: `Rimuovi la persona chiamata "${name}" dalla frase, correggendo la grammatica e concordanze italiane e mantenendo il resto del contesto intatto.`,
              provider: aiEngine === 'customCloud' ? customCloudProvider : aiEngine,
              customCloudKey: customCloudKey.trim() || undefined,
              cloudModel: customCloudModel.trim() || undefined,
              ollamaUrl,
              ollamaModels: selectedOllamaModels,
              ollamaModel: selectedOllamaModels[0] || 'llava:latest'
            })
          });

          if (response.ok) {
            const data = await response.json();
            if (data && (data.title || data.description)) {
              const rewrittenTitle = data.title || updatedMeta.title;
              const rewrittenDesc = data.description || updatedMeta.description;
              updatedMeta.title = cleanDuplicateNames(rewrittenTitle, [name]);
              updatedMeta.description = cleanDuplicateNames(rewrittenDesc, [name]);
              
              const polishedImage = {
                ...selectedImage,
                metadata: { ...updatedMeta },
                analyzed: true
              };
              setSelectedImage(polishedImage);
              setImages(prev => prev.map(img => img.path === selectedImage.path ? polishedImage : img));
            }
          }
        } catch (e) {
          console.warn("AI text rewrite non critico:", e);
        } finally {
          setAnalyzingSingle(false);
        }
      }

      const finalImage = {
        ...selectedImage,
        metadata: { ...updatedMeta },
        analyzed: true
      };

      await saveImageMetadata(finalImage);
      showToast("Persona rimossa con successo!");

    } catch (err) {
      console.error("Error removing face:", err);
      showToast("Errore durante la rimozione della persona.", "error");
    } finally {
      setAnalyzingSingle(false);
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
          headers: { 
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey.trim()}` } : {})
          },
          body: JSON.stringify({
            title: title,
            description: description,
            instruction: `Aggiungi la persona chiamata "${name}" alla frase. Integra la persona nel contesto (ad esempio, se prima si parlava genericamente di "un uomo" o "un bambino", sostituiscilo con "${name}"). Correggi la grammatica e non lasciare frasi a metà.`,
            provider: aiEngine,
            ollamaUrl,
            ollamaModels: selectedOllamaModels,
            ollamaModel: selectedOllamaModels[0] || 'llava:latest'
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          const rewrittenTitle = data.title || title;
          const rewrittenDesc = data.description || description;
          updatedMeta.title = cleanDuplicateNames(rewrittenTitle, [name]);
          updatedMeta.description = cleanDuplicateNames(rewrittenDesc, [name]);
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

  const filteredImages = images.filter(img => {
    if (filterState === 'all') return true;
    if (filterState === 'new') return img.isNew;
    if (filterState === 'analyzed') return img.analyzed && !img.isNew;
    if (filterState === 'pending') return !img.analyzed && !img.isNew;
    return true;
  });

  const allFilteredSelected = filteredImages.length > 0 && filteredImages.every(img => selectedImagePaths.has(img.path));

  const handleToggleAllFiltered = () => {
    const newSet = new Set(selectedImagePaths);
    if (allFilteredSelected) {
      filteredImages.forEach(img => newSet.delete(img.path));
    } else {
      filteredImages.forEach(img => newSet.add(img.path));
    }
    setSelectedImagePaths(newSet);
  };

  const handleResetSelectedTags = async () => {
    if (selectedImagePaths.size === 0) return;
    
    setProcessing(true);
    let updatedImages = [...images];
    
    for (const imgPath of selectedImagePaths) {
      const imgIdx = updatedImages.findIndex(img => img.path === imgPath);
      if (imgIdx > -1) {
        const updatedImg = {
          ...updatedImages[imgIdx],
          analyzed: false,
          metadata: {
            title: '',
            description: '',
            keywords: [],
            faces: []
          }
        };
        updatedImages[imgIdx] = updatedImg;
        await saveImageMetadata(updatedImg);
        
        if (selectedImage && selectedImage.path === imgPath) {
          setSelectedImage(updatedImg);
        }
      }
    }
    
    setImages(updatedImages);
    setProcessing(false);
    showToast(`Tag rimossi da ${selectedImagePaths.size} foto.`);
  };

  return (
    <div className="app-container">
      {/* Sidebar Left */}
      <aside 
        className="sidebar sidebar-glass" 
        style={{ 
          width: `${sidebarWidth}px`, 
          minWidth: `${sidebarWidth}px`, 
          maxWidth: `${sidebarWidth}px` 
        }}
      >
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

          <div className="sidebar-header" style={{ marginTop: '16px' }}>🧠 Istruzione AI Personalizzata</div>
          <div style={{ padding: '0 8px', marginBottom: '24px' }}>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: '1.4' }}>
              Descrivi il contesto dell'evento o della scena. L'AI userà queste informazioni per generare titoli e descrizioni molto più precisi.
            </p>
            <textarea
              className="form-input"
              placeholder={'Es. "Matrimonio di Luca e Sara a Villa d\'Este, settembre 2025. I bambini si chiamano Emma e Samuele."'}
              value={customInstruction}
              onChange={e => setCustomInstruction(e.target.value)}
              rows={4}
              style={{ width: '100%', resize: 'vertical', fontSize: '12px', lineHeight: '1.5', fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
            {customInstruction.trim() && (
              <button
                className="btn btn-secondary"
                style={{ marginTop: '6px', fontSize: '11px', padding: '4px 10px' }}
                onClick={() => setCustomInstruction('')}
              >
                ✕ Cancella istruzione
              </button>
            )}
          </div>

          <div className="sidebar-header" style={{ marginTop: '16px' }}>Persone Evento</div>
          <div style={{ padding: '0 8px', marginBottom: '16px' }}>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: 1.4 }}>
              Aggiungi persone all'evento specificando il genere per coniugare correttamente descrizioni e articoli.
            </p>
            <div style={{ marginBottom: eventPersons.length > 0 ? '8px' : '0' }}>
              {eventPersons.map(person => (
                <div key={person.name} className="event-person-item">
                  <span style={{ fontWeight: '500', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={person.name}>
                    {person.name}
                  </span>
                  <div className="gender-toggle">
                    <button
                      type="button"
                      className={`gender-toggle-btn ${person.gender === 'M' ? 'active-m' : ''}`}
                      onClick={() => {
                        setEventPersons(prev => prev.map(p => p.name === person.name ? { ...p, gender: 'M' } : p));
                      }}
                      title="Uomo (maschile)"
                    >
                      Uomo
                    </button>
                    <button
                      type="button"
                      className={`gender-toggle-btn ${person.gender === 'F' ? 'active-f' : ''}`}
                      onClick={() => {
                        setEventPersons(prev => prev.map(p => p.name === person.name ? { ...p, gender: 'F' } : p));
                      }}
                      title="Donna (femminile)"
                    >
                      Donna
                    </button>
                  </div>
                  <button 
                    type="button"
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '15px', padding: '0 2px', lineHeight: 1 }}
                    onClick={() => setEventPersons(prev => prev.filter(p => p.name !== person.name))}
                    title={`Rimuovi ${person.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input 
                className="form-input" 
                style={{ flex: 1 }} 
                placeholder="Es. Roberto" 
                value={newEventPerson}
                onChange={(e) => setNewEventPerson(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newEventPerson.trim()) {
                    const clean = newEventPerson.trim();
                    setEventPersons(prev => {
                      if (prev.some(p => p.name.toLowerCase() === clean.toLowerCase())) return prev;
                      return [...prev, { name: clean, gender: 'M' }];
                    });
                    setNewEventPerson('');
                  }
                }}
              />
              <button 
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0 12px', flexShrink: 0 }}
                onClick={() => {
                  if (newEventPerson.trim()) {
                    const clean = newEventPerson.trim();
                    setEventPersons(prev => {
                      if (prev.some(p => p.name.toLowerCase() === clean.toLowerCase())) return prev;
                      return [...prev, { name: clean, gender: 'M' }];
                    });
                    setNewEventPerson('');
                  }
                }}
                title="Aggiungi persona all'evento"
              >
                +
              </button>
            </div>
          </div>

          <div className="sidebar-header" style={{ marginTop: '16px' }}>Motore AI & Analisi</div>
          <div style={{ padding: '0 8px', marginBottom: '16px' }}>
            {/* Opzione 1: Google Gemini (Cloud) */}
            <div 
              className={`ai-engine-card ${aiEngine === 'gemini' ? 'active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setAiEngine('gemini');
                setExpandedEngine(prev => prev === 'gemini' ? null : 'gemini');
              }}
            >
              <div className="ai-engine-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="radio"
                    name="aiEngine"
                    checked={aiEngine === 'gemini'}
                    onChange={() => {
                      setAiEngine('gemini');
                      setExpandedEngine('gemini');
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span className="ai-engine-title">☁️ Google Gemini</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="status-dot-badge" title={geminiConnected ? "Chiave API valida inserita" : "Chiave API mancante"}>
                    <span className={`status-dot ${geminiConnected ? 'green' : 'red'}`}></span>
                    <span style={{ color: geminiConnected ? '#34C759' : '#FF3B30' }}>
                      {geminiConnected ? 'Connesso' : 'Non attiva'}
                    </span>
                  </span>
                  <span style={{ fontSize: '9px', opacity: 0.6 }}>{expandedEngine === 'gemini' ? '▲' : '▼'}</span>
                </div>
              </div>
              {expandedEngine === 'gemini' && (
                <div className="ai-engine-body" onClick={(e) => e.stopPropagation()} style={{ paddingTop: '8px' }}>
                  <label className="form-label" style={{ fontSize: '10px', marginBottom: '2px', display: 'block' }}>Chiave API (Google AI Studio)</label>
                  <input 
                    type="password"
                    className="form-input" 
                    style={{ width: '100%', fontSize: '11px', padding: '4px 6px', minHeight: 'unset' }} 
                    placeholder="Incolla GEMINI_API_KEY" 
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Opzione 2: Ollama Vision (Locale Offline) */}
            <div 
              className={`ai-engine-card ${aiEngine === 'ollama' ? 'active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setAiEngine('ollama');
                setExpandedEngine(prev => prev === 'ollama' ? null : 'ollama');
              }}
            >
              <div className="ai-engine-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="radio"
                    name="aiEngine"
                    checked={aiEngine === 'ollama'}
                    onChange={() => {
                      setAiEngine('ollama');
                      setExpandedEngine('ollama');
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span className="ai-engine-title">🦙 Ollama Vision</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="status-dot-badge" title={ollamaConnected ? "Ollama in esecuzione" : "Ollama non rilevato"}>
                    <span className={`status-dot ${ollamaConnected ? 'green' : 'red'}`}></span>
                    <span style={{ color: ollamaConnected ? '#34C759' : '#FF3B30' }}>
                      {ollamaConnected ? 'Attivo' : 'Offline'}
                    </span>
                  </span>
                  <span style={{ fontSize: '9px', opacity: 0.6 }}>{expandedEngine === 'ollama' ? '▲' : '▼'}</span>
                </div>
              </div>
              {expandedEngine === 'ollama' && (
                <div className="ai-engine-body" onClick={(e) => e.stopPropagation()} style={{ paddingTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <label className="form-label" style={{ fontSize: '10px', margin: 0, fontWeight: '600' }}>
                      Modelli Vision (Selezione Multipla)
                    </label>
                    <button 
                      type="button" 
                      onClick={checkProvidersStatus}
                      style={{ background: 'none', border: 'none', color: 'var(--accent-color)', fontSize: '10px', cursor: 'pointer', padding: 0 }}
                      title="Ricarica modelli Ollama"
                    >
                      {ollamaChecking ? '⏳...' : '🔄 Ricarica'}
                    </button>
                  </div>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '6px' }}>
                    {ollamaModels.length > 0 ? (
                      ollamaModels.map(m => {
                        const isSelected = selectedOllamaModels.includes(m);
                        const isLlava = m.includes('llava');
                        const isMoon = m.includes('moondream');
                        const isLlama = m.includes('llama3.2');
                        const badgeLabel = isLlama ? '11B OCR' : isLlava ? 'Vision 7B (Consigliato)' : isMoon ? '1.8B (Sperimentale)' : 'Vision';

                        return (
                          <label 
                            key={m}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '3px 6px',
                              borderRadius: '5px',
                              backgroundColor: isSelected ? 'rgba(0, 122, 255, 0.08)' : 'rgba(128, 128, 128, 0.04)',
                              border: `1px solid ${isSelected ? 'rgba(0, 122, 255, 0.25)' : 'rgba(128, 128, 128, 0.08)'}`,
                              cursor: 'pointer',
                              fontSize: '11px',
                              margin: 0
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {
                                  setSelectedOllamaModels(prev => {
                                    if (prev.includes(m)) {
                                      if (prev.length === 1) return prev;
                                      return prev.filter(x => x !== m);
                                    } else {
                                      return [...prev, m];
                                    }
                                  });
                                }}
                                style={{ cursor: 'pointer', margin: 0 }}
                              />
                              <span style={{ fontWeight: isSelected ? '600' : '400', color: isSelected ? 'var(--accent-color)' : 'var(--text-primary)' }}>
                                {m}
                              </span>
                            </div>
                            <span style={{ fontSize: '9px', opacity: 0.7, padding: '1px 4px', borderRadius: '3px', backgroundColor: 'rgba(128,128,128,0.1)' }}>
                              {badgeLabel}
                            </span>
                          </label>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '4px 0' }}>
                        Nessun modello rilevato. Clicca 🔄 Ricarica.
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: '8px', marginBottom: '8px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{
                        width: '100%',
                        fontSize: '11px',
                        padding: '5px 8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                        borderRadius: '6px',
                        border: '1px dashed var(--accent-color)',
                        color: 'var(--accent-color)',
                        backgroundColor: 'rgba(0, 122, 255, 0.05)',
                        cursor: isImportingModel ? 'wait' : 'pointer'
                      }}
                      onClick={handleImportLocalModel}
                      disabled={isImportingModel}
                      title="Seleziona la cartella locale con i file .gguf o Modelfile per registrarla direttamente in Ollama"
                    >
                      <span>📁</span>
                      <span>{isImportingModel ? '⏳ Caricamento in corso...' : 'Carica da Cartella / USB'}</span>
                    </button>
                  </div>

                  {selectedOllamaModels.length > 1 && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '3px 6px',
                      backgroundColor: 'rgba(52, 199, 89, 0.12)',
                      border: '1px solid rgba(52, 199, 89, 0.25)',
                      borderRadius: '5px',
                      fontSize: '10px',
                      color: '#248a3d',
                      marginBottom: '6px',
                      fontWeight: '500'
                    }}>
                      <span>🤝</span>
                      <span>Fusione Cooperativa ({selectedOllamaModels.length} modelli in parallelo)</span>
                    </div>
                  )}
                  <label className="form-label" style={{ fontSize: '10px', marginBottom: '2px', display: 'block' }}>Host URL</label>
                  <input 
                    type="text"
                    className="form-input" 
                    style={{ width: '100%', fontSize: '10px', padding: '3px 6px', minHeight: 'unset', color: 'var(--text-secondary)' }} 
                    placeholder="http://localhost:11434" 
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Opzione 3: Altri Provider Cloud (OpenAI, Claude, Groq Free, OpenRouter) */}
            <div 
              className={`ai-engine-card ${aiEngine === 'customCloud' ? 'active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setAiEngine('customCloud');
                setExpandedEngine(prev => prev === 'customCloud' ? null : 'customCloud');
              }}
            >
              <div className="ai-engine-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="radio"
                    name="aiEngine"
                    checked={aiEngine === 'customCloud'}
                    onChange={() => {
                      setAiEngine('customCloud');
                      setExpandedEngine('customCloud');
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span className="ai-engine-title">🌐 Altri Provider Cloud</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="status-dot-badge" title={customCloudConnected ? "Chiave API valida" : "Inserisci la chiave API"}>
                    <span className={`status-dot ${customCloudConnected ? 'green' : 'red'}`}></span>
                    <span style={{ color: customCloudConnected ? '#34C759' : '#FF3B30' }}>
                      {customCloudConnected ? 'Pronto' : 'Chiave mancante'}
                    </span>
                  </span>
                  <span style={{ fontSize: '9px', opacity: 0.6 }}>{expandedEngine === 'customCloud' ? '▲' : '▼'}</span>
                </div>
              </div>
              {expandedEngine === 'customCloud' && (
                <div className="ai-engine-body" onClick={(e) => e.stopPropagation()} style={{ paddingTop: '8px' }}>
                  <label className="form-label" style={{ fontSize: '10px', marginBottom: '2px', display: 'block' }}>
                    Servizio AI
                  </label>
                  <select
                    className="form-input"
                    style={{ width: '100%', fontSize: '11px', padding: '4px 6px', marginBottom: '6px' }}
                    value={customCloudProvider}
                    onChange={(e) => setCustomCloudProvider(e.target.value)}
                  >
                    <option value="openrouter">🪐 OpenRouter (Multi-modello Free - Consigliato)</option>
                    <option value="groq">⚡ Groq Cloud (Llama 3.2 11B Vision - 100% GRATIS)</option>
                    <option value="openai">🤖 OpenAI (gpt-4o-mini)</option>
                    <option value="claude">🎭 Anthropic Claude (3.5 Haiku Vision)</option>
                  </select>

                  <label className="form-label" style={{ fontSize: '10px', marginBottom: '2px', display: 'block' }}>
                    {customCloudProvider === 'openrouter' && 'Chiave API OpenRouter (openrouter.ai)'}
                    {customCloudProvider === 'groq' && 'Chiave API Groq (gratuita su console.groq.com)'}
                    {customCloudProvider === 'openai' && 'Chiave API OpenAI (platform.openai.com)'}
                    {customCloudProvider === 'claude' && 'Chiave API Anthropic (console.anthropic.com)'}
                  </label>
                  <input 
                    type="password"
                    className="form-input" 
                    style={{ width: '100%', fontSize: '11px', padding: '4px 6px', minHeight: 'unset' }} 
                    placeholder={
                      customCloudProvider === 'groq' ? 'Incolla gsk_...' :
                      customCloudProvider === 'openai' ? 'Incolla sk-...' :
                      customCloudProvider === 'claude' ? 'Incolla sk-ant-...' :
                      'Incolla sk-or-...'
                    }
                    value={customCloudKey}
                    onChange={(e) => setCustomCloudKey(e.target.value)}
                  />

                  {customCloudProvider === 'openrouter' && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                        <label className="form-label" style={{ fontSize: '10px', margin: 0 }}>
                          Modelli Vision Rilevati (Live da OpenRouter)
                        </label>
                        <a 
                          href="https://openrouter.ai/models?max_price=0" 
                          target="_blank" 
                          rel="noreferrer" 
                          style={{ fontSize: '9px', color: 'var(--accent-primary)', textDecoration: 'none' }}
                          title="Vedi lista completa modelli su OpenRouter"
                        >
                          Catalogo ↗
                        </a>
                      </div>
                      <select
                        className="form-input"
                        style={{ width: '100%', fontSize: '10px', padding: '3px 6px', minHeight: 'unset', marginBottom: '4px' }}
                        value={
                          openrouterModels.some(m => m.id === customCloudModel)
                            ? customCloudModel
                            : 'custom'
                        }
                        onChange={(e) => {
                          if (e.target.value !== 'custom') {
                            setCustomCloudModel(e.target.value);
                          } else {
                            setCustomCloudModel('');
                          }
                        }}
                      >
                        {openrouterModels.map(m => (
                          <option key={m.id} value={m.id}>
                            {m.id.includes('nemotron-3.5-super-vl') ? '⭐ ' : '🟢 '}
                            {m.name}
                          </option>
                        ))}
                        <option value="custom">✍️ Altro modello (digita ID personalizzato)...</option>
                      </select>

                      {(!openrouterModels.some(m => m.id === customCloudModel)) && (
                        <input 
                          type="text"
                          className="form-input" 
                          style={{ width: '100%', fontSize: '10px', padding: '3px 6px', minHeight: 'unset' }} 
                          placeholder="Es: nvidia/nemotron-3.5-super-vl:free o openai/gpt-4o-mini" 
                          value={customCloudModel}
                          onChange={(e) => setCustomCloudModel(e.target.value)}
                        />
                      )}
                    </div>
                  )}

                  <p style={{ fontSize: '10px', color: 'var(--text-secondary)', margin: '6px 0 0 0', lineHeight: 1.3 }}>
                    {customCloudProvider === 'openrouter' && '🪐 OpenRouter connette a decine di modelli gratuiti rilevati online in tempo reale.'}
                    {customCloudProvider === 'groq' && '⚡ Groq offre un tier gratuito ultra-veloce (~0.5s) per Llama 3.2 Vision.'}
                    {customCloudProvider === 'openai' && '✨ gpt-4o-mini offre descrizioni e titoli italiani ad altissima fedeltà visiva.'}
                    {customCloudProvider === 'claude' && '💡 Claude 3.5 Haiku eccelle nella comprensione del contesto e nel linguaggio.'}
                  </p>
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: '100%', fontSize: '11px', color: '#ff5c5c', borderColor: 'rgba(255,92,92,0.3)', padding: '6px', marginTop: '10px' }}
              onClick={() => setShowShutdownConfirm(true)}
            >
              ⏻ Spegni Server e Chiudi
            </button>
          </div>
        </nav>
      </aside>

      {/* Sidebar Resizer Handle */}
      <div 
        className="sidebar-resizer"
        onMouseDown={(e) => {
          e.preventDefault();
          isResizingSidebar.current = true;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />

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
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer', margin: 0, color: 'var(--text-secondary)' }}>
                  <input 
                    type="checkbox" 
                    checked={allFilteredSelected}
                    onChange={handleToggleAllFiltered}
                  />
                  <span>Seleziona Tutte</span>
                </label>

                <div 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '6px', 
                    background: 'rgba(128, 128, 128, 0.08)', 
                    padding: '3px 8px', 
                    borderRadius: '16px',
                    border: '0.5px solid rgba(128, 128, 128, 0.15)',
                    marginLeft: '8px'
                  }} 
                  title={`Dimensione icone: ${thumbnailSize}px (trascina per ridimensionare)`}
                >
                  <span style={{ fontSize: '11px', opacity: 0.6 }}>🔍</span>
                  <input 
                    type="range"
                    min="110"
                    max="340"
                    step="10"
                    value={thumbnailSize}
                    onChange={(e) => setThumbnailSize(Number(e.target.value))}
                    style={{
                      width: '85px',
                      height: '4px',
                      cursor: 'pointer',
                      accentColor: 'var(--accent-color)'
                    }}
                  />
                  <span style={{ fontSize: '11px', fontWeight: '500', minWidth: '38px', color: 'var(--text-secondary)' }}>
                    {thumbnailSize}px
                  </span>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {activeTab === 'photos' && images.length > 0 && (
              <div className="toolbar-actions">
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
                    onClick={handleResetSelectedTags} 
                    disabled={processing}
                  >
                    Azzera Tag ({selectedImagePaths.size})
                  </button>
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => {
                      setSelectedImagePaths(new Set());
                      setShiftStartIdx(null);
                    }} 
                    disabled={processing}
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
                        const res = await saveImageMetadata(selectedImage);
                        setProcessing(false);
                        if (res && res.success) {
                          const updated = { ...selectedImage, analyzed: true, isNew: false };
                          setSelectedImage(updated);
                          setImages(prev => prev.map(img => img.path === selectedImage.path ? updated : img));
                          showToast(`Metadati di "${selectedImage.name}" salvati!`);
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
            <button
              type="button"
              className="btn-power-toolbar"
              title="Spegni Server e Chiudi App"
              onClick={() => setShowShutdownConfirm(true)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                <line x1="12" y1="2" x2="12" y2="12"></line>
              </svg>
            </button>
          </div>
        </header>

        {processing && (
          <div>
            <div style={{ padding: '10px 24px', fontSize: '13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--accent-light)', borderBottom: '1px solid rgba(0, 122, 255, 0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                <span style={{ display: 'inline-block', width: '13px', height: '13px', border: '2px solid rgba(0, 122, 255, 0.3)', borderTopColor: 'var(--accent-color)', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }}></span>
                <span style={{ fontWeight: '500', color: 'var(--accent-color)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {currentProcessingName || 'Elaborazione in corso...'}
                </span>
              </div>
              <span style={{ fontWeight: '600', color: 'var(--accent-color)', marginLeft: '12px', flexShrink: 0 }}>{progress}%</span>
            </div>
            <div className="batch-progress-bar">
              <div className="batch-progress-fill" style={{ width: `${Math.max(2, progress)}%` }}></div>
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
              <div className="photo-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))` }}>
                {filteredImages.map(img => (
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
              document.body.style.userSelect = 'none';
            }}
          />
          <aside 
            className="inspector glass" 
            style={{ 
              width: `${inspectorWidth}px`,
              minWidth: `${inspectorWidth}px`,
              maxWidth: `${inspectorWidth}px`
            }}
          >
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
                      {eventPersons.length > 0 && (
                        <optgroup label="Persone Evento">
                          {eventPersons.map(p => (
                            <option key={p.name} value={p.name}>{p.name} ({p.gender === 'F' ? 'Donna' : 'Uomo'})</option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Database Volti Globale">
                        {people.map(p => (
                          <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                      </optgroup>
                      <option value="new">+ Nuova persona (Personalizzata)...</option>
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
              const res = await saveImageMetadata(selectedImage);
              setProcessing(false);
              if (res && res.success) {
                const updated = { ...selectedImage, analyzed: true, isNew: false };
                setSelectedImage(updated);
                setImages(prev => prev.map(img => img.path === selectedImage.path ? updated : img));
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
                {eventPersons.length > 0 && (
                  <optgroup label="Persone Evento">
                    {eventPersons.map(p => (
                      <option key={p.name} value={p.name}>{p.name} ({p.gender === 'F' ? 'Donna' : 'Uomo'})</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Database Volti Globale">
                  {(() => {
                    const list = people.length > 0 ? people : [
                      { name: 'Mattia' }, { name: 'Tiziana' }, { name: 'Samuele' }
                    ];
                    return list.map(p => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ));
                  })()}
                </optgroup>
                <option value="new">+ Nuova Persona (Personalizzata)...</option>
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

      {/* Shutdown Confirmation Modal */}
      {showShutdownConfirm && (
        <div className="modal-overlay" style={{ zIndex: 99999 }}>
          <div className="modal-content" style={{ maxWidth: '420px', padding: '28px' }}>
            <div style={{ color: '#ff3b30', marginBottom: '14px', display: 'flex', justifyContent: 'center' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                <line x1="12" y1="2" x2="12" y2="12"></line>
              </svg>
            </div>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: 600 }}>Chiudi Photo Tag Pro</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.5, margin: '0 0 24px 0' }}>
              Sei sicuro di voler fermare il server e chiudere l'App?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button 
                type="button"
                className="btn btn-secondary" 
                style={{ flex: 1, padding: '10px 16px', fontSize: '13px' }} 
                onClick={() => setShowShutdownConfirm(false)}
              >
                No, Annulla
              </button>
              <button 
                type="button"
                className="btn" 
                style={{ flex: 1, padding: '10px 16px', fontSize: '13px', backgroundColor: '#ff3b30', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '8px', cursor: 'pointer' }}
                onClick={async () => {
                  setShowShutdownConfirm(false);
                  try {
                    await fetch(`${API_BASE}/api/shutdown`, { method: 'POST' });
                  } catch (e) {}
                  window.close();
                }}
              >
                Sì, Spegni e Chiudi
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
