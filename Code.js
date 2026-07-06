/**
 * DISPATCH PLACEMENT — Backend Google Apps Script
 * ------------------------------------------------
 * À coller dans l'éditeur Apps Script du Google Sheet (Extensions > Apps Script).
 * Déployer ensuite : Déployer > Nouveau déploiement > Application Web.
 *
 * Clés à renseigner dans Paramètres du projet > Propriétés du script :
 *   MISTRAL_API_KEY : clé gratuite (plan "Experiment") sur console.mistral.ai
 *   PRIM_API_KEY    : clé gratuite Île-de-France Mobilités sur prim.iledefrance-mobilites.fr
 */

const CFG = {
  SHEET_ETUDIANTS: 'PREINSCRITS 26/27',
  SHEET_AGENDA: 'AGENDA',
  SHEET_ANALYSES: 'ANALYSES_IA',      // cache des analyses de CV (créée auto)
  SHEET_HISTORIQUE: 'HISTORIQUE',     // journal des envois/placements (créée auto)
  SHEET_SUIVI: 'SUIVI_APPELS',        // suivi des appels par étudiant : une ligne par
                                      // étudiant (nom / prénom / tel), une colonne
                                      // "Entretien n" par tentative, avec le motif
                                      // (pas intéressé, ne répond pas, pas dispo),
                                      // l'entreprise et sa localisation (créée auto)
  SHEET_CACHE_GEO: 'CACHE_GEO',       // cache géocodage adresses (créée auto)
  SHEET_CV_TEXTES: 'CV_TEXTES',       // texte brut extrait des CV, jamais ré-extrait (créée auto)
  SHEET_ANALYSES_ENT: 'ANALYSES_ENTREPRISES', // analyses IA des entreprises (créée auto)
  COL_PROMO: 13,                      // colonne M de PREINSCRITS : promotion (BTS MCO / NDRC).
                                      // Lecture DIRECTE : la détection par en-tête échouait,
                                      // c'est pour ça que le filtre MCO/NDRC ne filtrait rien.
  COL_MAIL: 5,                        // colonne E de PREINSCRITS : adresse mail de l'étudiant
  COL_HISTO_DEBUT: 27,                // colonne AA de PREINSCRITS : début de l'historique d'entretiens
  COL_HISTO_FIN: 38,                  // colonne AL de PREINSCRITS : fin de l'historique
  COL_FICHE_POSTE: 8,                 // colonne H d'AGENDA : lien Drive de la fiche de poste
                                      // (optionnel — jointe au mail de confirmation si présente)
  DUREE_ENTRETIEN_MIN: 60,            // un entretien dure 1 h : règle anti-collision d'horaires
  TAMPON_ENTRETIEN_MIN: 120,          // on privilégie un étudiant SANS entretien à ±2 h
  VERSION_ANALYSE: 'v2',              // changer cette valeur force la ré-analyse de tous les CV
  VERSION_ANALYSE_ENT: 'v2',          // idem pour les ENTREPRISES : v2 = prompt anti-invention
                                      // (ne rien inventer si l'entreprise n'est pas connue,
                                      // postes "envisageables", exigences colonne E fidèles)
  NB_CRENEAUX: 12,                    // 12 blocs de 3 colonnes dans AGENDA
  COL_PREMIER_BLOC: 9,                // colonne I : 1er bloc "NOM Prénom | Eleve placé 1"
  COL_STATUT_PLACEMENT: 24,           // colonne X de PREINSCRITS : statut placement.
                                      // Seuls les étudiants avec X vide ou "vide" sont proposés
                                      // ("à faire", "fait", etc. = déjà en entreprise → exclus).
  MARGE_ARRIVEE_MIN: 0,               // minutes d'avance visées sur l'heure du RDV.
                                      // 0 = l'étudiant arrive pile à l'heure de l'entretien.
                                      // Mettre 10 ou 15 pour viser une arrivée en avance.
  MAX_MARCHE_VERS_TC_SEC: 1800,       // max_duration_to_pt : marche MAX (en secondes) tolérée
                                      // pour rejoindre un arrêt aux deux extrémités du trajet.
                                      // 1800 = 30 min. Plus la valeur est haute, plus un point
                                      // géocodé "loin du réseau" (ville seule) réussit à
                                      // raccrocher aux transports au lieu de sortir une marche.
  DEBUG_ITINERAIRE: true,             // true = journalise chaque appel PRIM (URL, code HTTP,
                                      // réponse brute) dans les Logs. À repasser à false une
                                      // fois le diagnostic terminé (sinon les Logs se remplissent).
  COULEUR_MASQUE: '#f4cccc',          // fond rouge posé sur A:H quand une entreprise est masquée
  FONDS_MASQUES: ['#f4cccc', '#ea9999', '#e06666', '#cc0000', '#ff0000', '#990000'],
  ORDRE_NOTES: ['fusée', 'bon profil', 'plaçable', 'potentiel à travailler', 'cave', 'desinscrit'],
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Dispatch Placement')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ============================= LECTURE DONNÉES ============================= */

function api_getData() {
  // Chaque lecture est étiquetée : si l'une échoue, le message d'erreur reçu
  // par l'appli dit EXACTEMENT laquelle (fini les pages blanches muettes).
  const lire = (nom, fn) => {
    try { return fn(); }
    catch (e) { throw new Error('Échec de lecture « ' + nom + ' » : ' + (e && e.message ? e.message : e)); }
  };
  // sansDates_ : google.script.run ÉCHOUE EN BLOC si la réponse contient un
  // objet Date, où que ce soit (cf. le commentaire de lireHistorique_). Depuis
  // que TOUS les étudiants sont renvoyés (même placés/désinscrits), une seule
  // cellule Date inattendue (diplôme, avis, contact…) suffisait à tout casser.
  // On convertit donc récursivement toute Date en chaîne ISO avant l'envoi.
  return sansDates_({
    entreprises: lire('AGENDA (entreprises)', lireEntreprises_),
    etudiants: lire('PREINSCRITS (étudiants)', lireEtudiants_),
    analyses: lire('ANALYSES_IA', lireAnalyses_),
    analysesEntreprises: lire('ANALYSES_ENTREPRISES', lireAnalysesEntreprises_),
    historique: lire('HISTORIQUE', lireHistorique_),
    regles: { duree: CFG.DUREE_ENTRETIEN_MIN, tampon: CFG.TAMPON_ENTRETIEN_MIN },
    maintenant: new Date().toISOString(),
  });
}

/** Rechargement LÉGER pour l'actualisation en direct : uniquement les
 *  entreprises et leurs créneaux (les étudiants/analyses bougent peu). */
function api_refresh() {
  return sansDates_({ entreprises: lireEntreprises_(), maintenant: new Date().toISOString() });
}

/** Convertit récursivement toute Date en chaîne ISO : garantit qu'un payload
 *  google.script.run ne contient JAMAIS d'objet Date (sinon l'appel entier
 *  échoue côté client, sans message exploitable). */
function sansDates_(o) {
  if (o == null) return o;
  if (o instanceof Date) return isNaN(o) ? '' : o.toISOString();
  if (Array.isArray(o)) return o.map(sansDates_);
  if (typeof o === 'object') { const r = {}; for (const k in o) r[k] = sansDates_(o[k]); return r; }
  return o;
}

/** Cellule → texte SÛR pour l'appli : les Dates deviennent lisibles
 *  ("jj/mm/aaaa hh:mm"), tout le reste passe par String(). */
function txt_(v) {
  if (v == null) return '';
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, 'Europe/Paris', 'dd/MM/yyyy HH:mm');
  return String(v);
}

/** DIAGNOSTIC — à lancer depuis l'éditeur (▶ Exécuter) puis lire le journal :
 *  reproduit le chargement complet de l'appli, section par section, avec les
 *  temps, le volume du payload, et signale toute Date résiduelle. C'est le
 *  premier réflexe si la webapp ne démarre plus. */
function testChargementDonnees() {
  let t = Date.now();
  const ent = lireEntreprises_();
  Logger.log('1/5 Entreprises (AGENDA) : ' + ent.length + ' — ' + (Date.now() - t) + ' ms');
  t = Date.now();
  const etu = lireEtudiants_();
  Logger.log('2/5 Étudiants (PREINSCRITS) : ' + etu.length + ' — ' + (Date.now() - t) + ' ms');
  Logger.log('    dont plaçables : ' + etu.filter(s => s.placable).length +
    ' · entretiens lus (AA→AL) : ' + etu.reduce((n, s) => n + s.entretiens.length, 0));
  etu.filter(s => s.entretiens.length).slice(0, 3).forEach(s =>
    Logger.log('    ex. ' + s.prenom + ' ' + s.nom + ' → ' + JSON.stringify(s.entretiens)));
  t = Date.now();
  lireAnalyses_(); Logger.log('3/5 ANALYSES_IA OK — ' + (Date.now() - t) + ' ms');
  t = Date.now();
  lireAnalysesEntreprises_(); Logger.log('4/5 ANALYSES_ENTREPRISES OK — ' + (Date.now() - t) + ' ms');
  t = Date.now();
  const payload = api_getData();
  const dates = [];
  chercherDates_(payload, '', dates);
  Logger.log('5/5 api_getData COMPLET — ' + (Date.now() - t) + ' ms — ' +
    Math.round(JSON.stringify(payload).length / 1024) + ' Ko — Dates résiduelles : ' +
    (dates.length ? '⚠ ' + dates.join(', ') : 'aucune ✓'));
  Logger.log('Si les 5 étapes s\'affichent sans erreur rouge, le serveur est sain : le problème est côté déploiement ou interface.');
}

function chercherDates_(o, chemin, trouves) {
  if (o instanceof Date) { trouves.push(chemin || '(racine)'); return; }
  if (o && typeof o === 'object') for (const k in o) chercherDates_(o[k], chemin + '.' + k, trouves);
}

function lireEtudiants_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_ETUDIANTS);
  const data = sh.getDataRange().getValues();
  const head = data[0].map(h => String(h).toLowerCase());
  const idx = (frag) => head.findIndex(h => h.indexOf(frag) !== -1);
  // Cherche le premier en-tête contenant l'un des fragments (tolère les
  // libellés variables : "Ville", "Commune", "Localité", "Departement"…).
  const idxAny = (frags) => { for (let i = 0; i < frags.length; i++) { const j = idx(frags[i]); if (j !== -1) return j; } return -1; };
  const c = {
    nom: idx('nom'), prenom: idx('prénom'), tel: idx('tel |'),
    dept: idxAny(['département', 'departement', 'dépt', 'dept', 'code postal']),
    ville: idxAny(['ville', 'commune', 'localité', 'localite']),
    sexe: idx('sexe'), permis: idx('permis'),
    diplome: idx('dernier diplôme'), noteCloser: idx('note closer'),
    avisClosing: idx('avis post closing'), noteWorkshop: idx('note workshop'),
    avisWorkshop: idx('avis post workshop'), emploi: idx("type d'emploi"),
    cv: head.lastIndexOf('cv'),
  };
  if (c.cv === -1) c.cv = 38; // repli : colonne AM (39e colonne, index 38)
  // Colonnes FIXES (la détection par en-tête était trop fragile selon les libellés) :
  //   M = promotion MCO/NDRC — c'est ce qui cassait le filtre MCO/NDRC côté appli ;
  //   E = adresse mail (utilisée pour le mail de confirmation d'entretien).
  const cPromo = CFG.COL_PROMO - 1, cMail = CFG.COL_MAIL - 1;

  // IMPORTANT — getValues() ne renvoie que le TEXTE AFFICHÉ d'un lien cliquable,
  // jamais l'URL. Il faut lire la couche rich text (et les formules HYPERLINK).
  const richCV = sh.getRange(1, c.cv + 1, data.length, 1).getRichTextValues();
  const formCV = sh.getRange(1, c.cv + 1, data.length, 1).getFormulas();

  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[c.nom] && !row[c.prenom]) continue;
    const noteW = String(row[c.noteWorkshop] || '').toLowerCase().trim();
    const noteC = String(row[c.noteCloser] || '').toLowerCase().trim();
    const desinscrit = (noteW === 'desinscrit' || noteC === 'desinscrit');
    // Colonne X = statut de placement. "à faire", "fait"… = déjà en entreprise.
    const statutX = String(row[CFG.COL_STATUT_PLACEMENT - 1] || '').toLowerCase().trim();
    const dejaPlace = !!(statutX && statutX !== 'vide');
    // TOUS les étudiants sont désormais renvoyés — même placés ou désinscrits —
    // pour que l'HISTORIQUE D'ENTRETIENS (AA → AL) se charge pour chacun et que
    // les statuts des entretiens PASSÉS restent consultables et modifiables.
    // Le flag "placable" pilote côté appli qui peut être proposé sur un créneau.
    const placable = !desinscrit && !dejaPlace;
    // Garde-fous : jamais "undefined" si l'en-tête ville/dépt n'a pas été trouvé,
    // sinon l'itinéraire partait de "undefined France" (→ marche seule / erreur).
    const villeStr = c.ville === -1 ? '' : String(row[c.ville] || '').trim();
    const deptStr = c.dept === -1 ? '' : String(row[c.dept] || '').trim();
    out.push({
      id: 'E' + (r + 1), ligne: r + 1,
      // txt_ : SÛRETÉ — depuis que toutes les lignes sont lues (même
      // placées/désinscrites), n'importe laquelle de ces cellules peut
      // contenir une Date ou un type inattendu.
      nom: txt_(row[c.nom]), prenom: txt_(row[c.prenom]), tel: String(row[c.tel] || ''),
      mail: String(row[cMail] || '').trim(), ville: villeStr, departement: deptStr,
      promo: String(row[cPromo] || '').trim(), diplome: txt_(row[c.diplome]),
      sexe: extraireSexe_(row[c.sexe]),
      permis: c.permis === -1 ? '' : extrairePermis_(row[c.permis]),
      noteCloser: noteC, noteWorkshop: noteW,
      avisClosing: txt_(row[c.avisClosing]), avisWorkshop: txt_(row[c.avisWorkshop]),
      emploiSouhaite: txt_(row[c.emploi]),
      cvUrl: extraireUrlCellule_(richCV[r][0], formCV[r][0], row[c.cv]),
      // cvBrut = texte AFFICHÉ de la cellule CV : permet au contrôle qualité de
      // distinguer "CV manquant" (cellule vide) de "lien invalide" (texte sans URL).
      cvBrut: String(row[c.cv] == null ? '' : row[c.cv]).trim(),
      placable: placable,
      motifNonPlacable: desinscrit ? 'désinscrit' : (dejaPlace ? 'colonne X : ' + statutX : ''),
      // Le géocodage (coûteux) n'est fait que pour les étudiants encore à placer.
      geo: (placable && villeStr) ? geocoderSouple_(villeStr + ' ' + deptStr + ' France') : null,
      note: noteW || noteC, // la meilleure info dispo
      entretiens: lireEntretiensLigne_(row), // colonnes AA → AL : historique des entretiens
    });
  }
  return out;
}

/** Historique des entretiens d'un étudiant : colonnes AA → AL de PREINSCRITS.
 *  FORMAT RÉEL : ces colonnes sont remplies AUTOMATIQUEMENT par un script du
 *  Sheet dès qu'un bloc d'AGENDA contient au moins D/H + nom prénom. TOUTES
 *  les infos d'un entretien tiennent dans UNE SEULE cellule : nom de
 *  l'entreprise, localisation, date/heure, et le statut une fois renseigné
 *  dans AGENDA. AA → AL fonctionne donc comme une petite base de données en
 *  LECTURE SEULE : on n'y écrit jamais depuis l'appli (c'est le bloc AGENDA
 *  qu'on modifie ; le script du Sheet resynchronise AA → AL tout seul).
 *  RÈGLE MÉTIER : pas de statut → l'entretien n'a PAS encore eu lieu
 *  (il bloque donc les créneaux en conflit côté appli). */
function lireEntretiensLigne_(row) {
  const out = [];
  const fin = Math.min(CFG.COL_HISTO_FIN, row.length);
  for (let i = CFG.COL_HISTO_DEBUT - 1; i < fin; i++) {
    const en = parseCelluleEntretien_(row[i]);
    if (en) { en.col = i + 1; out.push(en); }
  }
  return out;
}

/** Parse UNE cellule d'historique contenant tout l'entretien :
 *  « Entreprise · localisation · jj/mm/aaaa hh:mm · statut ».
 *  Lecture TOLÉRANTE (le séparateur et l'ordre peuvent varier) :
 *   - la DATE est détectée n'importe où dans le texte (jj/mm/aaaa, avec ou
 *     sans heure "14:00" / "14h" / "à 14h00", ou ISO) ;
 *   - le STATUT est détecté par mot-clé (accepté, en attente, refusé,
 *     pas venu, absence justifiée) ;
 *   - le reste, découpé sur les séparateurs ( — | ; • · saut de ligne, ou
 *     tiret ENTOURÉ d'espaces pour ne pas casser "Boulogne-Billancourt"),
 *     donne l'ENTREPRISE (1er segment) puis la LOCALISATION.
 *  "brut" conserve le texte d'origine : affiché en infobulle côté appli et
 *  utilisé par le contrôle qualité quand aucune date n'est détectable. */
function parseCelluleEntretien_(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return { dh: v.toISOString(), entreprise: '', lieu: '', statut: '', brut: '' };
  }
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // 1. DATE (+ heure éventuelle) n'importe où dans le texte
  let dh = '', dateTxt = '';
  let m = s.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})(?:\s*(?:à|a|,|-)?\s*(\d{1,2})\s*[:hH]\s*(\d{2})?)?/);
  if (m) {
    const an = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(an, Number(m[2]) - 1, Number(m[1]), Number(m[4] == null ? 9 : m[4]), Number(m[5] || 0));
    if (!isNaN(d)) { dh = d.toISOString(); dateTxt = m[0]; }
  } else {
    m = s.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/);
    if (m) { const d = new Date(m[0]); if (!isNaN(d)) { dh = d.toISOString(); dateTxt = m[0]; } }
  }

  // 2. STATUT par mot-clé (le libellé exact de la feuille est conservé)
  const mSt = s.match(/accept[ée]e?|en attente|absence justifi[ée]e?|refus[ée]e?|pas venue?/i);
  const statut = mSt ? mSt[0].trim() : '';

  // 3. Le reste = entreprise puis localisation
  let reste = s;
  if (dateTxt) reste = reste.replace(dateTxt, ' | ');
  if (mSt) reste = reste.replace(mSt[0], ' | ');
  const seg = reste
    .split(/\s*\|\s*|\s+[–—]\s+|\s+-\s+|;|•|·|\n/)
    .map(x => x.replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, ''))
    .filter(Boolean);
  return { dh: dh, entreprise: seg[0] || '', lieu: seg.slice(1).join(', '), statut: statut, brut: s };
}

/** Parse STRICT d'une cellule de l'historique : objet Date du Sheet,
 *  "jj/mm/aaaa[ hh:mm]" ou ISO. Volontairement plus strict que
 *  parseDateSouple_ pour ne pas prendre un nom d'entreprise pour une date. */
function parseDateCellule_(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T]+(\d{1,2})[:hH](\d{2}))?/);
  if (m) return new Date(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]),
    Number(m[2]) - 1, Number(m[1]), Number(m[4] || 9), Number(m[5] || 0));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); return isNaN(d) ? null : d; }
  return null;
}

function lireEntreprises_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_AGENDA);
  const data = sh.getDataRange().getValues();
  // Fond de la colonne B : une ligne rouge = entreprise masquée manuellement
  const fonds = sh.getRange(1, 2, data.length, 1).getBackgrounds();
  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[1]) continue; // colonne B = Entreprise
    if (CFG.FONDS_MASQUES.indexOf(String(fonds[r][0]).toLowerCase()) !== -1) continue; // masquée
    const creneaux = [];
    for (let k = 0; k < CFG.NB_CRENEAUX; k++) {
      const base = CFG.COL_PREMIER_BLOC - 1 + k * 3;
      const nomEleve = String(row[base] || '').trim();
      const dh = row[base + 1];
      const statut = String(row[base + 2] || '').trim();
      if (!dh) continue;
      creneaux.push({
        index: k, dh: (dh instanceof Date) ? dh.toISOString() : String(dh),
        eleve: nomEleve, statut: statut,
        libre: !nomEleve && !statut, // un créneau avec un statut (ou un nom) est consommé
      });
    }
    const placés = creneaux.filter(cn => /accept/i.test(cn.statut)).length;
    const postes = Number(row[5]) || 0;
    out.push({
      id: 'A' + (r + 1), ligne: r + 1,
      placeur: txt_(row[0]), nom: txt_(row[1]), adresse: String(row[2] || ''),
      contact: txt_(row[3]), commentaires: txt_(row[4]),
      postesOuverts: postes, placés: placés,
      postesRestants: Math.max(0, postes - placés),
      creneauxLibres: creneaux.filter(cn => cn.libre).length,
      creneaux: creneaux,
      // Géocodage SOUPLE : adresse imprécise → repli automatique sur la ville
      geo: geocoderSouple_(String(row[2] || '')),
    });
  }
  // Les entreprises dont tous les postes sont pourvus ne sont pas renvoyées.
  // Celles sans créneau libre restent dans la liste latérale mais
  // n'apparaissent pas sur la carte (filtrage côté interface).
  return out.filter(e => e.postesRestants > 0);
}

/** Masque une entreprise : pose un fond rouge sur ses colonnes d'infos (A → H)
 *  dans AGENDA, sans toucher aux blocs d'entretiens (colonne I et suivantes). */
function api_masquerEntreprise(ligne, nomEntreprise) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_AGENDA);
  sh.getRange(ligne, 1, 1, CFG.COL_PREMIER_BLOC - 1).setBackground(CFG.COULEUR_MASQUE);
  getOrCreateSheet_(CFG.SHEET_HISTORIQUE,
    ['date_action', 'etudiant', 'tel', 'entreprise', 'creneau', 'action', 'par'])
    .appendRow([new Date(), '', '', nomEntreprise, '', 'Entreprise masquée',
      Session.getActiveUser().getEmail()]);
  return { ok: true };
}

/* ============================= GÉOCODAGE (cache) ============================= */

let GEO_MEM = null; // cache en mémoire, chargé UNE fois par exécution

/** Clé de cache normalisée : minuscules + espaces uniques. Évite les
 *  quasi-doublons ("Paris " / "paris") qui gonflaient CACHE_GEO. */
function normAdr_(a) {
  return String(a || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function geoMem_() {
  if (GEO_MEM) return GEO_MEM;
  const sh = getOrCreateSheet_(CFG.SHEET_CACHE_GEO, ['adresse', 'lat', 'lng', 'statut']);
  const cache = sh.getDataRange().getValues();
  GEO_MEM = { sh: sh, map: {} };
  for (let i = 1; i < cache.length; i++) {
    const cle = normAdr_(cache[i][0]);
    if (!cle || (cle in GEO_MEM.map)) continue; // doublons historiques ignorés à la lecture
    const lat = cache[i][1], lng = cache[i][2];
    // Une ligne SANS coordonnées = échec déjà connu → on ne re-géocode plus.
    GEO_MEM.map[cle] = (lat !== '' && lat != null && lng !== '' && lng != null)
      ? { lat: lat, lng: lng } : null;
  }
  return GEO_MEM;
}

/** Géocode une adresse avec cache persistant dans CACHE_GEO.
 *  Corrige les deux problèmes constatés :
 *   1. les ÉCHECS sont aussi écrits (statut "introuvable") : une ville déjà
 *      testée n'est plus re-géocodée à chaque chargement ;
 *   2. l'écriture passe par un VERROU + une re-vérification dans la feuille,
 *      car les appels serveur tournent EN PARALLÈLE (10 itinéraires lancés
 *      d'un coup) : chacun rechargeait son propre cache puis écrivait la même
 *      adresse → c'est ce qui multipliait les lignes dans CACHE_GEO. */
function geocoder_(adresse) {
  const cle = normAdr_(adresse);
  if (!cle) return null;
  const g = geoMem_();
  if (cle in g.map) return g.map[cle];
  let geo = null;
  try {
    const res = Maps.newGeocoder().setRegion('fr').geocode(cle);
    if (res.status === 'OK' && res.results.length) {
      const loc = res.results[0].geometry.location;
      geo = { lat: loc.lat, lng: loc.lng };
    }
  } catch (e) { /* quota / adresse invalide */ }
  g.map[cle] = geo;
  ecrireCacheGeo_(cle, geo);
  return geo;
}

/** Écriture protégée dans CACHE_GEO : verrou script + vérification que la clé
 *  n'a pas déjà été écrite par une exécution concurrente. Jamais bloquant. */
function ecrireCacheGeo_(cle, geo) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { return; } // une autre exécution écrira
  try {
    const sh = geoMem_().sh;
    const der = sh.getLastRow();
    const deja = der > 0 &&
      sh.getRange(1, 1, der, 1).createTextFinder(cle).matchEntireCell(true).findNext();
    if (!deja) sh.appendRow([cle, geo ? geo.lat : '', geo ? geo.lng : '', geo ? 'OK' : 'introuvable']);
  } catch (e) { /* l'écriture cache ne doit jamais faire échouer l'appel */ }
  finally { lock.releaseLock(); }
}

/** GÉOCODAGE "SOUPLE" — accepte les adresses IMPRÉCISES, comme Google Maps :
 *  si l'adresse complète échoue, on retombe sur des variantes de plus en plus
 *  larges jusqu'au NOM DE VILLE seul :
 *   1. l'adresse telle quelle ;
 *   2. code postal + ville ;
 *   3. dernier segment après une virgule (souvent la ville) ;
 *   4. adresse sans le numéro de rue ;
 *   5. les derniers mots sans chiffres + "France" (le nom de la ville).
 *  Chaque variante passe par le cache : un échec n'est testé qu'UNE fois. */
function geocoderSouple_(adresse) {
  const essais = variantesAdresse_(adresse);
  for (let i = 0; i < essais.length; i++) {
    const g = geocoder_(essais[i]);
    if (g) return g;
  }
  return null;
}

function variantesAdresse_(adresse) {
  const a = String(adresse || '').replace(/\s+/g, ' ').trim();
  if (!a) return [];
  const v = [a];
  const cp = a.match(/(\d{5})\s*[-,]?\s*([A-Za-zÀ-ÿ'’\- ]{2,})/); // code postal + ville
  if (cp) v.push(cp[1] + ' ' + cp[2].trim() + ' France');
  const seg = a.split(',').map(s => s.trim()).filter(Boolean);
  if (seg.length > 1) v.push(seg[seg.length - 1] + ' France');    // dernier segment
  const sansNum = a.replace(/^\d+\s*(bis|ter)?\s*,?\s*/i, '');
  if (sansNum && sansNum !== a) v.push(sansNum + (/france/i.test(sansNum) ? '' : ' France'));
  const mots = a.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  if (mots.length >= 2) v.push(mots.slice(-2).join(' ') + ' France');
  else if (mots[0]) v.push(mots[0] + ' France');
  const uniq = [];
  v.forEach(x => { const n = normAdr_(x); if (n && uniq.indexOf(n) === -1) uniq.push(n); });
  return uniq;
}

/** MAINTENANCE — à lancer UNE FOIS depuis l'éditeur : déduplique CACHE_GEO,
 *  normalise les clés et marque les échecs "introuvable". */
function nettoyerCacheGeo() {
  const sh = getOrCreateSheet_(CFG.SHEET_CACHE_GEO, ['adresse', 'lat', 'lng', 'statut']);
  const data = sh.getDataRange().getValues();
  const vus = {}, lignes = [['adresse', 'lat', 'lng', 'statut']];
  for (let i = 1; i < data.length; i++) {
    const cle = normAdr_(data[i][0]);
    if (!cle || vus[cle]) continue;
    vus[cle] = true;
    const ok = data[i][1] !== '' && data[i][1] != null;
    lignes.push([cle, ok ? data[i][1] : '', ok ? data[i][2] : '', ok ? 'OK' : 'introuvable']);
  }
  sh.clearContents();
  sh.getRange(1, 1, lignes.length, 4).setValues(lignes);
  Logger.log((data.length - lignes.length) + ' doublon(s) supprimé(s), ' +
    (lignes.length - 1) + ' adresse(s) en cache.');
}

/* ============================= ANALYSE IA (Mistral, cache) ============================= */

function lireAnalyses_() {
  const sh = getOrCreateSheet_(CFG.SHEET_ANALYSES,
    ['cle', 'etudiant', 'date_analyse', 'resume', 'competences', 'points_forts', 'alerte', 'json']);
  const data = sh.getDataRange().getValues();
  const out = {}, courtV2 = {};
  for (let i = 1; i < data.length; i++) {
    try {
      const analyse = JSON.parse(data[i][7]);
      const cle = String(data[i][0]);
      out[cle] = analyse;                                 // clé complète "Exx|hash|vN"
      const court = cle.split('|')[0];                    // clé courte "Exx" (frontend)
      // Les analyses NOUVELLE GÉNÉRATION (v2 : secteurs, qualités, centres
      // d'intérêt, permis) sont prioritaires sur les anciennes.
      if (cle.indexOf('|' + CFG.VERSION_ANALYSE) !== -1) { out[court] = analyse; courtV2[court] = true; }
      else if (!courtV2[court]) out[court] = analyse;
    } catch (e) {}
  }
  return out;
}

/** Analyse le CV d'un étudiant. Ne refait JAMAIS une analyse déjà en cache
 *  (clé = id étudiant + hash de l'URL du CV + version du prompt : passer
 *  CFG.VERSION_ANALYSE à "v3" relancerait toutes les analyses).
 *
 *  PROMPT v2 — recentré sur la réalité du placement : étudiants de 1re/2e
 *  année de BTS visant des postes à FAIBLE RESPONSABILITÉ. On n'évoque plus
 *  l'expérience internationale (sauf exigence de l'entreprise, lue ailleurs
 *  dans la colonne E d'AGENDA). On extrait ce qui sert au MATCHING :
 *  expériences + secteurs, qualités, centres d'intérêt — et le PERMIS,
 *  détecté dans le CV et STOCKÉ dans ANALYSES_IA pour alimenter le filtre. */
function api_analyserCV(etudiantId, nomComplet, cvUrl) {
  const cle = etudiantId + '|' + hash_(cvUrl || nomComplet) + '|' + CFG.VERSION_ANALYSE;
  const cacheSheet = getOrCreateSheet_(CFG.SHEET_ANALYSES,
    ['cle', 'etudiant', 'date_analyse', 'resume', 'competences', 'points_forts', 'alerte', 'json']);
  const existantes = lireAnalyses_();
  if (existantes[cle]) return { cle: cle, analyse: existantes[cle], depuisCache: true };

  const texteCV = extraireTexteCV_(cvUrl);
  const prompt = 'Tu analyses le CV d\'un candidat en BTS MCO ou NDRC en ALTERNANCE (1re ou 2e année). ' +
    'Contexte : postes à FAIBLE RESPONSABILITÉ — vendeur, conseiller de vente, relation client, accueil. ' +
    'NE PAS mettre en avant l\'expérience internationale ni les séjours à l\'étranger. ' +
    'Objectif : extraire ce qui sert au MATCHING avec des entreprises (retail, téléphonie, mode, beauté, ' +
    'restauration, high-tech, culture…) : les expériences et leurs SECTEURS, les qualités, les centres d\'intérêt. ' +
    'Réponds UNIQUEMENT en JSON valide, sans backticks, avec ces clés : ' +
    '{"resume": "2 phrases concrètes centrées vente / relation client", ' +
    '"experiences": [{"poste": "...", "secteur": "..."}], ' +
    '"secteurs": ["secteurs déjà pratiqués (jobs, stages)"], ' +
    '"qualites": ["3 à 5 qualités déduites du CV"], ' +
    '"centres_interet": ["centres d\'intérêt utiles au matching"], ' +
    '"competences": ["compétences opérationnelles : caisse, conseil, prospection, réseaux sociaux…"], ' +
    '"permis": "oui si le permis B est mentionné dans le CV, non si absence explicite, sinon chaîne vide", ' +
    '"alerte": "vide ou point de vigilance", "score_retail": 0-25}. ' +
    'CV :\n' + (texteCV || '(CV illisible : évaluer prudemment, score_retail max 10)');

  const analyse = appelMistral_(prompt);
  cacheSheet.appendRow([cle, nomComplet, new Date(),
    analyse.resume || '', (analyse.competences || []).join(', '),
    [].concat(analyse.qualites || [], analyse.centres_interet || []).join(', '),
    analyse.alerte || '', JSON.stringify(analyse)]);
  return { cle: cle, analyse: analyse, depuisCache: false };
}

/* ==================== ANALYSE IA DES ENTREPRISES (cache) ==================== */

function lireAnalysesEntreprises_() {
  const sh = getOrCreateSheet_(CFG.SHEET_ANALYSES_ENT,
    ['cle', 'entreprise', 'date_analyse', 'secteur', 'activite', 'postes', 'criteres', 'json']);
  const data = sh.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < data.length; i++) {
    try {
      const analyse = JSON.parse(data[i][7]);
      out[data[i][0]] = analyse;                               // clé complète (hash)
      out[String(data[i][1]).toLowerCase().trim()] = analyse;  // nom d'entreprise (frontend)
    } catch (e) {}
  }
  return out;
}

/** Analyse IA d'une ENTREPRISE : ce qu'elle fait, son secteur, les postes
 *  possibles pour un alternant BTS MCO/NDRC, et les EXIGENCES EXPLICITES du
 *  placeur (colonne E d'AGENDA : anglais, présentation, permis…).
 *  Cache dans ANALYSES_ENTREPRISES : la clé inclut les commentaires, donc une
 *  entreprise n'est ré-analysée QUE si ses commentaires changent. */
function api_analyserEntreprise(nomEntreprise, adresse, commentaires) {
  // La clé inclut la VERSION du prompt : passer VERSION_ANALYSE_ENT à "v3"
  // relancerait toutes les analyses (les anciennes v1 sans version sont
  // automatiquement ignorées puisque leur clé ne matche plus).
  const cle = hash_(nomEntreprise + '|' + (commentaires || '') + '|' + CFG.VERSION_ANALYSE_ENT);
  const sh = getOrCreateSheet_(CFG.SHEET_ANALYSES_ENT,
    ['cle', 'entreprise', 'date_analyse', 'secteur', 'activite', 'postes', 'criteres', 'json']);
  const existantes = lireAnalysesEntreprises_();
  if (existantes[cle]) return { cle: cle, analyse: existantes[cle], depuisCache: true };

  // PROMPT v2 — FIABILITÉ AVANT TOUT :
  //  1. interdiction d'inventer : si l'entreprise n'est pas une enseigne connue
  //     et établie, l'analyse le DIT ("infos_suffisantes": false) au lieu de
  //     broder un secteur ou une activité plausibles ;
  //  2. "postes_envisageables" (et non "postes") : de simples pistes réalistes ;
  //  3. les EXIGENCES viennent EXCLUSIVEMENT des commentaires du placeur
  //     (colonne E d'AGENDA), reprises fidèlement, jamais complétées.
  const prompt = 'Tu analyses une ENTREPRISE qui accueille des alternants BTS MCO (vente, retail) ' +
    'ou NDRC (relation client, prospection, digital). ' +
    'RÈGLE ABSOLUE : ne JAMAIS inventer. Tu ne décris le secteur et l\'activité QUE si l\'entreprise est une ' +
    'enseigne connue et établie que tu identifies avec certitude, ou si l\'adresse et les commentaires le ' +
    'disent explicitement. Sinon : mets "infos_suffisantes": false, "secteur": "", "mots_cles": [], et une ' +
    '"activite" qui indique clairement que les informations disponibles ne permettent pas d\'identifier ' +
    'l\'entreprise avec certitude. Dans le doute, choisis toujours "infos_suffisantes": false. ' +
    'Les COMMENTAIRES DU PLACEUR (colonne E de l\'AGENDA) sont la source la plus fiable : reprends FIDÈLEMENT ' +
    'dans "criteres" TOUTES les exigences qui y figurent (anglais, présentation, permis, expérience, ' +
    'disponibilité…), sans en inventer ni en ajouter d\'autres. ' +
    'Réponds UNIQUEMENT en JSON valide, sans backticks, avec ces clés : ' +
    '{"infos_suffisantes": true ou false, ' +
    '"secteur": "secteur principal (téléphonie, mode, beauté, restauration, culture, high-tech…) ou chaîne vide si inconnu", ' +
    '"activite": "1 phrase sur ce que fait l\'entreprise, ou sur le manque d\'informations", ' +
    '"postes_envisageables": ["postes ENVISAGEABLES (pas garantis) pour un alternant BTS 1re/2e année"], ' +
    '"criteres": ["exigences EXPLICITES des commentaires uniquement"], ' +
    '"mots_cles": ["mots-clés de matching CERTAINS uniquement : secteur, produits, clientèle"], ' +
    '"promo_conseillee": "MCO, NDRC ou chaîne vide si indifférent"}. ' +
    'Entreprise : ' + nomEntreprise +
    '\nAdresse : ' + (adresse || '?') +
    '\nCommentaires du placeur (colonne E) : ' + (commentaires || '(aucun)');

  const analyse = appelMistral_(prompt);
  sh.appendRow([cle, nomEntreprise, new Date(), analyse.secteur || '',
    analyse.activite || '', (analyse.postes_envisageables || analyse.postes || []).join(', '),
    (analyse.criteres || []).join(', '), JSON.stringify(analyse)]);
  return { cle: cle, analyse: analyse, depuisCache: false };
}

/** À LANCER MANUELLEMENT (ou via déclencheur nocturne) : analyse en lot les
 *  entreprises de l'AGENDA pas encore en cache. Relancer si "restantes > 0". */
function precacherAnalysesEntreprises() {
  const debut = Date.now();
  const entreprises = lireEntreprises_();
  const analyses = lireAnalysesEntreprises_();
  let faites = 0, restantes = 0;
  for (const e of entreprises) {
    // MÊME clé versionnée que api_analyserEntreprise, sinon tout serait ré-analysé
    const cle = hash_(e.nom + '|' + (e.commentaires || '') + '|' + CFG.VERSION_ANALYSE_ENT);
    if (analyses[cle]) continue;
    if (Date.now() - debut > 4.5 * 60 * 1000) { restantes++; continue; }
    try {
      api_analyserEntreprise(e.nom, e.adresse, e.commentaires);
      faites++;
      Utilities.sleep(1100); // rythme plan gratuit Mistral
    } catch (err) { Logger.log('Échec analyse ' + e.nom + ' : ' + err.message); }
  }
  Logger.log(faites + ' entreprise(s) analysée(s), ' + restantes + ' restante(s) — relancer si > 0.');
}

function appelMistral_(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty('MISTRAL_API_KEY');
  if (!key) throw new Error('MISTRAL_API_KEY manquante dans les propriétés du script.');
  const res = UrlFetchApp.fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + key },
    contentType: 'application/json',
    payload: JSON.stringify({
      model: 'mistral-small-latest', // inclus dans le plan gratuit "Experiment"
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());
  return JSON.parse(body.choices[0].message.content);
}

/** Récupère l'URL réelle d'une cellule CV, quel que soit le mode de stockage :
 *  1. lien cliquable posé sur le texte (rich text) — le cas de la colonne AM ;
 *  2. formule =HYPERLINK("url" ; "texte") ;
 *  3. URL en clair dans la cellule. */
function extraireUrlCellule_(richText, formule, valeur) {
  if (richText) {
    const runs = richText.getRuns();
    for (let i = 0; i < runs.length; i++) {
      const u = runs[i].getLinkUrl();
      if (u) return u;
    }
    const u = richText.getLinkUrl();
    if (u) return u;
  }
  const m = String(formule || '').match(/HYPERLINK\s*\(\s*"([^"]+)"/i);
  if (m) return m[1];
  const v = String(valeur || '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  return '';
}

/** Extrait un ID de fichier Drive depuis les formats d'URL courants :
 *  .../d/{id}/..., ...?id={id}, ou un ID nu. */
function extraireDriveId_(url) {
  const m = String(url).match(/\/d\/([-\w]{25,})|[?&]id=([-\w]{25,})|^([-\w]{25,})$/);
  return m ? (m[1] || m[2] || m[3]) : '';
}

/** Extrait le texte d'un CV (PDF ou image → OCR via Drive).
 *  Le texte est stocké dans CV_TEXTES avec un STATUT : un même CV n'est
 *  jamais ré-extrait, et les échecs sont visibles dans la feuille au lieu
 *  d'être avalés silencieusement. */
function extraireTexteCV_(url) {
  url = String(url || '').trim();
  if (!url) return '';
  const sh = getOrCreateSheet_(CFG.SHEET_CV_TEXTES,
    ['file_id', 'url', 'date_extraction', 'texte', 'statut']);
  const cle = extraireDriveId_(url) || hash_(url);
  const cache = sh.getDataRange().getValues();
  for (let i = 1; i < cache.length; i++) {
    if (cache[i][0] === cle) return String(cache[i][3]);
  }
  let texte = '', statut = 'OK';
  try {
    let blob;
    const id = extraireDriveId_(url);
    if (id) {
      blob = DriveApp.getFileById(id).getBlob();
    } else {
      // URL externe (pas Drive) : on télécharge le PDF puis on l'OCRise pareil
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() >= 400) throw new Error('HTTP ' + res.getResponseCode());
      blob = res.getBlob();
    }
    texte = ocrDrive_(blob);
    if (!texte) statut = 'VIDE (document sans texte détectable)';
  } catch (e) {
    statut = 'ERREUR : ' + e.message;
  }
  sh.appendRow([cle, url, new Date(), texte, statut]);
  return texte;
}

/** Conversion PDF/image → Google Doc avec OCR (nécessite le service avancé
 *  "Drive API" activé dans Services +). Le doc temporaire est toujours supprimé. */
function ocrDrive_(blob) {
  const tmp = Drive.Files.create(
    { name: 'ocr_tmp_cv', mimeType: 'application/vnd.google-apps.document' },
    blob, { ocrLanguage: 'fr' });
  try {
    return DocumentApp.openById(tmp.id).getBody().getText().slice(0, 12000);
  } finally {
    Drive.Files.remove(tmp.id);
  }
}

/** À LANCER MANUELLEMENT (ou via déclencheur nocturne) : extrait et analyse
 *  en lot tous les CV pas encore en cache. Respecte le quota d'exécution
 *  Apps Script (arrêt à ~4 min 30) et le rythme du plan gratuit Mistral
 *  (~1 requête/s). Relancer jusqu'à ce que le log affiche 0 restant. */
function precacherAnalysesCV() {
  const debut = Date.now();
  const etudiants = lireEtudiants_();
  const analyses = lireAnalyses_();
  let faites = 0, restants = 0;
  for (const s of etudiants) {
    if (s.placable === false) continue; // placés / désinscrits : inutile d'analyser
    if (!s.cvUrl) continue;
    const cle = s.id + '|' + hash_(s.cvUrl) + '|' + CFG.VERSION_ANALYSE;
    if (analyses[cle]) continue;
    if (Date.now() - debut > 4.5 * 60 * 1000) { restants++; continue; }
    try {
      api_analyserCV(s.id, s.prenom + ' ' + s.nom, s.cvUrl);
      faites++;
      Utilities.sleep(1100); // rythme plan gratuit Mistral
    } catch (e) {
      Logger.log('Échec analyse ' + s.nom + ' : ' + e.message);
    }
  }
  Logger.log(faites + ' analyse(s) effectuée(s), ' + restants + ' restante(s) — relancer si > 0.');
}

/** Diagnostic : liste dans le journal ce que le script "voit" en colonne CV
 *  pour chaque étudiant (URL trouvée ou non). À lancer une fois pour vérifier. */
function diagnostiquerLiensCV() {
  const etudiants = lireEtudiants_();
  etudiants.forEach(s => Logger.log(
    s.prenom + ' ' + s.nom + ' → ' + (s.cvUrl ? s.cvUrl : '⚠ AUCUNE URL DÉTECTÉE')));
}

/** Normalise la colonne SEXE en 'F' ou 'H' (vide si indéterminé). */
function extraireSexe_(val) {
  const s = String(val || '').toUpperCase();
  if (/\bF\b|FILLE|FEMME/.test(s)) return 'F';
  if (/\bH\b|\bM\b|GAR|HOMME|MASC/.test(s)) return 'H';
  return '';
}

/** Normalise la colonne PERMIS en 'oui' / 'non' (vide si indéterminé).
 *  Accepte : oui / non, B / sans, x / ✔, vrai / faux, cases à cocher (TRUE/FALSE). */
function extrairePermis_(val) {
  if (val === true) return 'oui';
  if (val === false) return 'non';
  const s = String(val || '').toUpperCase().trim();
  if (!s) return '';
  if (/NON|SANS|FAUX|FALSE|^0$/.test(s)) return 'non';
  if (/OUI|PERMIS|VRAI|TRUE|^B$|^X$|✔|✓|^1$/.test(s)) return 'oui';
  return '';
}

/* ============================= ITINÉRAIRES (PRIM IDFM, cache) ============================= */

/** Parse souple d'une date de créneau : objet Date, chaîne ISO,
 *  ou format Sheet français "jj/mm/aaaa hh:mm". Renvoie null si illisible. */
function parseDateSouple_(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  const s = String(v || '').trim();
  let d = new Date(s);
  if (!isNaN(d)) return d;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]+(\d{1,2})[:h](\d{2})/i);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]); // fuseau du projet
  return null;
}

/** Appel PRIM générique : renvoie le JSON parsé, ou { erreur } si HTTP/JSON
 *  cassé ou erreur Navitia "dure". Les réponses "no_solution" (aucun trajet
 *  pour ces contraintes) NE sont PAS des erreurs : elles reviennent comme un
 *  résultat vide, pour permettre un second essai avec d'autres paramètres. */
function appelPrim_(url, key) {
  const res = UrlFetchApp.fetch(url, { headers: { apikey: key }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  const txt = res.getContentText();
  if (CFG.DEBUG_ITINERAIRE) {
    // Diagnostic : masque la clé si elle apparaissait dans l'URL, tronque le corps.
    Logger.log('PRIM HTTP ' + code + '  ← ' + url);
    Logger.log('PRIM réponse : ' + txt.slice(0, 1200));
  }
  let j;
  try { j = JSON.parse(txt); }
  catch (e) { return { erreur: 'Réponse PRIM illisible (HTTP ' + code + ')' }; }
  if (j.error && j.error.id !== 'no_solution' && j.error.id !== 'no_origin_nor_destination') {
    return { erreur: 'PRIM : ' + (j.error.message || j.error.id) };
  }
  return j;
}

/** Parmi les journeys renvoyés, garde ceux qui contiennent AU MOINS UNE
 *  section en transport en commun, et renvoie le plus court. */
function meilleurJourneyTC_(j) {
  const avecTC = (j.journeys || []).filter(x =>
    (x.sections || []).some(s => s.type === 'public_transport'));
  if (!avecTC.length) return null;
  avecTC.sort((a, b) => (a.duration || 0) - (b.duration || 0));
  return avecTC[0];
}

/** Itinéraire transport en commun réel (lignes, horaires, correspondances)
 *  via l'API gratuite PRIM d'Île-de-France Mobilités.
 *
 *  LOGIQUE : l'heure du rendez-vous EST l'heure d'arrivée visée.
 *  Grâce à datetime_represents=arrival, Navitia remonte le temps tout seul
 *  et détermine l'heure de départ + la durée de trajet pour arriver à l'heure.
 *
 *  BUG "trajets 100 % à pied" : avec count=1 et le mode par défaut, dès que
 *  Navitia juge une marche directe "raisonnable" (paramètre direct_path
 *  = indifferent), il la renvoie SEULE et écrase l'itinéraire en transport.
 *  Correctif en deux temps :
 *   1er essai  → direct_path=none : la marche directe est INTERDITE, Navitia
 *                est obligé de construire un vrai itinéraire en transport ;
 *                on prend le plus court parmi ceux qui contiennent du TC.
 *   2e essai   → si aucun trajet TC n'existe vraiment (ex. 400 m à faire),
 *                on relance sans contrainte et on accepte la marche : c'est
 *                alors un VRAI trajet à pied, pas un artefact de l'API.
 *
 *  max_duration_to_pt (30 min) : distinct du problème ci-dessus. Il autorise
 *  Navitia à marcher jusqu'à 30 min pour ATTEINDRE un arrêt à chaque bout.
 *  C'est ce qui évite qu'un point imprécis (repli sur la ville) reste "hors
 *  réseau" et déclenche une marche seule faute d'arrêt assez proche. */
function api_itineraire(origine, destination, arriveeIso) {
  // Diagnostic : journalise EXACTEMENT ce que l'appli envoie. C'est ici qu'on
  // voit si l'origine est "undefined France" (colonne ville/département mal
  // lue), si la destination est vide/imprécise, ou si la date est illisible.
  if (CFG.DEBUG_ITINERAIRE) {
    Logger.log('api_itineraire ← origine="' + origine + '" | destination="' +
      destination + '" | arriveeIso="' + arriveeIso + '" (' + typeof arriveeIso + ')');
  }
  // Géocodage SOUPLE : une adresse imprécise ("Rue de Rivoli Paris", voire
  // juste "Boulogne-Billancourt") est acceptée — comme sur Google Maps, on
  // calcule alors l'itinéraire vers le CENTRE de la ville.
  const from = geocoderSouple_(origine), to = geocoderSouple_(destination);
  if (!from || !to) return { erreur: 'Adresse et ville introuvables (' + (!from ? origine : destination) + ')' };
  const key = PropertiesService.getScriptProperties().getProperty('PRIM_API_KEY');
  if (!key) return { erreur: 'PRIM_API_KEY manquante dans les propriétés du script' };

  const rdv = parseDateSouple_(arriveeIso);
  if (!rdv) return { erreur: 'Date du créneau illisible (' + arriveeIso + ')' };
  const cible = new Date(rdv.getTime() - CFG.MARGE_ARRIVEE_MIN * 60000);
  const dt = Utilities.formatDate(cible, 'Europe/Paris', "yyyyMMdd'T'HHmmss");

  const urlBase = 'https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/journeys' +
    '?from=' + from.lng + ';' + from.lat + '&to=' + to.lng + ';' + to.lat +
    '&datetime=' + dt + '&datetime_represents=arrival' +
    // Marche MAX autorisée pour rejoindre un arrêt à chaque extrémité (30 min).
    // Sans ça, un point géocodé un peu loin du réseau (repli sur la ville) ne
    // "raccroche" pas aux transports → Navitia renvoie une marche seule, ou rien.
    '&max_duration_to_pt=' + CFG.MAX_MARCHE_VERS_TC_SEC;

  // 1er essai : transport en commun obligatoire (pas de marche directe),
  // count=3 pour avoir le choix et retenir le plus rapide.
  let j = appelPrim_(urlBase + '&count=3&direct_path=none', key);
  if (j.erreur) return j;
  let jo = meilleurJourneyTC_(j);

  // 2e essai (repli) : vraiment aucun trajet TC → on accepte la marche.
  if (!jo) {
    j = appelPrim_(urlBase + '&count=3', key);
    if (j.erreur) return j;
    jo = meilleurJourneyTC_(j) || (j.journeys || [])[0];
  }
  if (!jo) return { erreur: 'Aucun itinéraire trouvé' };

  const etapes = jo.sections.filter(s => s.type !== 'waiting').map(s => ({
    mode: s.type === 'public_transport' ? (s.display_informations.commercial_mode || 'Transport') : 'Marche',
    ligne: s.display_informations ? s.display_informations.code : '',
    couleur: s.display_informations ? '#' + (s.display_informations.color || '888') : '#888',
    direction: s.display_informations ? s.display_informations.direction : '',
    depart: s.departure_date_time, arrivee: s.arrival_date_time,
    de: s.from ? s.from.name : '', vers: s.to ? s.to.name : '',
    duree: Math.round(s.duration / 60),
  }));
  const result = {
    dureeTotale: Math.round(jo.duration / 60),
    depart: jo.departure_date_time, arrivee: jo.arrival_date_time,
    correspondances: Math.max(0, jo.nb_transfers || 0), etapes: etapes,
  };
  return result;
}

/** DIAGNOSTIC — à lancer depuis l'éditeur (menu ▶ Exécuter), puis lire
 *  "Journal d'exécution". Reproduit ton cas Malakoff → La Vache Noire et
 *  affiche : les coordonnées géocodées, l'URL PRIM complète, la réponse
 *  brute (grâce à DEBUG_ITINERAIRE) et le résultat final.
 *  Change les deux adresses ci-dessous pour tester d'autres cas. */
function testItineraire() {
  const origine = 'Malakoff France';
  const destination = 'Centre Commercial La Vache Noire, Pl. de la Vache Noire, 94110 Arcueil';
  // Prochain lundi 14h00, pour être sûr de viser une date FUTURE (une date
  // passée fait échouer le calcul transport et ne laisse que la marche).
  const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(14, 0, 0, 0);

  Logger.log('--- Géocodage ---');
  Logger.log('Origine     ' + origine + '  → ' + JSON.stringify(geocoderSouple_(origine)));
  Logger.log('Destination ' + destination + '  → ' + JSON.stringify(geocoderSouple_(destination)));
  Logger.log('Arrivée visée : ' + d.toISOString());
  Logger.log('--- Appel(s) PRIM (réponses brutes ci-dessous) ---');
  const r = api_itineraire(origine, destination, d.toISOString());
  Logger.log('--- Résultat final ---');
  Logger.log(JSON.stringify(r, null, 2));
}

/* ============================= PLACEMENT + HISTORIQUE ============================= */

/** Remplit la case "NOM Prénom" du créneau choisi dans AGENDA
 *  (l'automatisation existante crée alors l'événement Google Agenda). */
function api_placer(entrepriseLigne, indexCreneau, nomComplet, telEtudiant, nomEntreprise) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_AGENDA);
  const col = CFG.COL_PREMIER_BLOC + indexCreneau * 3;
  const cellNom = sh.getRange(entrepriseLigne, col);
  if (String(cellNom.getValue()).trim() || String(sh.getRange(entrepriseLigne, col + 2).getValue()).trim()) {
    return { ok: false, erreur: 'Ce créneau vient d\'être pris.' };
  }
  cellNom.setValue(nomComplet);
  const dh = sh.getRange(entrepriseLigne, col + 1).getValue();
  getOrCreateSheet_(CFG.SHEET_HISTORIQUE,
    ['date_action', 'etudiant', 'tel', 'entreprise', 'creneau', 'action', 'par'])
    .appendRow([new Date(), nomComplet, telEtudiant, nomEntreprise, dh, 'Placé sur créneau',
      Session.getActiveUser().getEmail()]);
  return { ok: true };
}

/* ================ STATUT D'UN ENTRETIEN PASSÉ (écrit dans AGENDA) ================ */

/** Change le statut d'un entretien depuis l'appli (une fois sa date passée).
 *  UNE SEULE écriture : la 3e colonne du bloc correspondant dans AGENDA —
 *  c'est la source de vérité. Les colonnes AA → AL de PREINSCRITS sont
 *  resynchronisées AUTOMATIQUEMENT par le script existant du Sheet (elles
 *  fonctionnent comme une base de données en lecture seule) : on ne les
 *  touche donc JAMAIS ici, sous peine de conflit avec cette automatisation.
 *  Le bloc est repéré par entreprise + date à la minute près (et nom d'élève
 *  quand il matche, insensible à l'ordre Prénom/Nom). Bloc introuvable =
 *  erreur franche renvoyée à l'appli : rien n'est écrit "au hasard". */
function api_changerStatutEntretien(dhIso, nomEntreprise, nouveauStatut, nomComplet) {
  nouveauStatut = String(nouveauStatut || '').trim();
  if (!nouveauStatut) return { ok: false, erreur: 'Statut vide.' };
  const cible = parseDateSouple_(dhIso);
  if (!cible) return { ok: false, erreur: 'Date d\'entretien illisible (' + dhIso + ').' };

  const okAgenda = majStatutAgenda_(nomEntreprise, cible, nomComplet, nouveauStatut);
  if (!okAgenda) {
    return { ok: false, erreur: 'Bloc AGENDA introuvable pour « ' + (nomEntreprise || '?') +
      ' » au créneau du ' + Utilities.formatDate(cible, 'Europe/Paris', 'dd/MM/yyyy HH:mm') +
      '. Vérifier que le bloc existe toujours (entreprise renommée ou créneau déplacé ?).' };
  }
  getOrCreateSheet_(CFG.SHEET_HISTORIQUE,
    ['date_action', 'etudiant', 'tel', 'entreprise', 'creneau', 'action', 'par'])
    .appendRow([new Date(), nomComplet || '', '', nomEntreprise || '', cible,
      'Statut d\'entretien → ' + nouveauStatut + ' (bloc AGENDA — AA→AL resynchronisé par le script du Sheet)',
      Session.getActiveUser().getEmail()]);
  return { ok: true };
}

/** Retrouve dans AGENDA le bloc [nom | date | statut] correspondant à un
 *  entretien et écrit le statut dans sa 3e colonne.
 *  1er passage : entreprise (si connue) + date + nom d'élève (comparaison
 *  insensible à l'ordre "Prénom Nom" / "NOM Prénom") ;
 *  2e passage plus tolérant : entreprise + date suffisent — mais uniquement
 *  si on a une entreprise pour ancrer la recherche (jamais la date seule,
 *  pour ne pas écrire dans le bloc d'une autre entreprise au même horaire). */
function majStatutAgenda_(nomEntreprise, dCible, nomEtudiant, statut) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_AGENDA);
  const data = sh.getDataRange().getValues();
  const nomEnt = normAdr_(nomEntreprise), nomEtu = normAdr_(nomEtudiant);
  for (let passe = 0; passe < 2; passe++) {
    if (passe === 1 && !nomEnt) break; // pas d'entreprise → jamais de match "date seule"
    for (let r = 1; r < data.length; r++) {
      const entLigne = normAdr_(data[r][1]); // colonne B = Entreprise
      if (!entLigne) continue;
      // Tolérance : "Zara" doit matcher "Zara — Rivoli" et inversement — utile
      // car le nom lu dans la cellule AA→AL peut différer légèrement de la
      // colonne B d'AGENDA (localisation accolée, séparateur avalé…).
      if (nomEnt && entLigne.indexOf(nomEnt) === -1 && nomEnt.indexOf(entLigne) === -1) continue;
      for (let k = 0; k < CFG.NB_CRENEAUX; k++) {
        const base = CFG.COL_PREMIER_BLOC - 1 + k * 3;
        const d = parseDateCellule_(data[r][base + 1]);
        if (!d || Math.abs(d - dCible) >= 60000) continue;
        if (passe === 0 && nomEtu && !memeNom_(data[r][base], nomEtu)) continue;
        sh.getRange(r + 1, base + 3).setValue(statut);
        return true;
      }
    }
  }
  return false;
}

/** Comparaison de noms insensible à l'ordre des mots : "Lucas MARTIN" et
 *  "MARTIN Lucas" matchent (tous les mots de l'un présents dans l'autre). */
function memeNom_(a, b) {
  const na = normAdr_(a), nb = normAdr_(b);
  if (!na || !nb) return false;
  const wa = na.split(' ').filter(Boolean), wb = nb.split(' ').filter(Boolean);
  return wa.every(w => wb.indexOf(w) !== -1) || wb.every(w => wa.indexOf(w) !== -1);
}

/* ============================= MAIL DE CONFIRMATION ============================= */

const JOURS_FR_ = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_FR_ = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** "lundi 6 juillet 2026 à 13h00" — formatage manuel car Utilities.formatDate
 *  sort les noms de jours/mois en anglais. */
function fmtDateFrMail_(d) {
  const u = Number(Utilities.formatDate(d, 'Europe/Paris', 'u')) % 7; // 1=lundi … 0=dimanche
  return JOURS_FR_[u] + ' ' + Utilities.formatDate(d, 'Europe/Paris', 'd') + ' ' +
    MOIS_FR_[Number(Utilities.formatDate(d, 'Europe/Paris', 'M')) - 1] + ' ' +
    Utilities.formatDate(d, 'Europe/Paris', 'yyyy') + ' à ' +
    Utilities.formatDate(d, 'Europe/Paris', 'HH:mm').replace(':', 'h');
}

/** Envoie à l'étudiant (adresse = colonne E de PREINSCRITS) le mail de
 *  confirmation : date/heure + lieu de l'entretien.
 *  FICHE DE POSTE : si la colonne H (CFG.COL_FICHE_POSTE) de la ligne de
 *  l'entreprise dans AGENDA contient un lien Google Drive (lien cliquable,
 *  formule HYPERLINK ou URL en clair), le fichier est JOINT au mail —
 *  converti en PDF si c'est un Doc/Slide Google. Sans lien, le mail part
 *  quand même, sans pièce jointe. */
function api_envoyerMailConfirmation(mail, prenom, nomComplet, nomEntreprise, adresse, dhIso, entrepriseLigne) {
  mail = String(mail || '').trim();
  if (!/@/.test(mail)) return { ok: false, erreur: 'Adresse mail introuvable en colonne E de PREINSCRITS.' };
  const d = parseDateSouple_(dhIso);
  const quand = d ? fmtDateFrMail_(d) : String(dhIso);

  let pieces = [], mentionFiche = '';
  try {
    if (entrepriseLigne) {
      const sh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEET_AGENDA);
      const cell = sh.getRange(entrepriseLigne, CFG.COL_FICHE_POSTE);
      const url = extraireUrlCellule_(cell.getRichTextValue(), cell.getFormula(), cell.getValue());
      const id = extraireDriveId_(url);
      if (id) {
        const f = DriveApp.getFileById(id);
        pieces = [/google-apps/.test(f.getMimeType()) ? f.getAs('application/pdf') : f.getBlob()];
        mentionFiche = 'Vous trouverez la fiche de poste en pièce jointe.\n\n';
      }
    }
  } catch (e) { /* pas de fiche exploitable : le mail part sans pièce jointe */ }

  const corps = 'Bonjour ' + (prenom || '') + ',\n\n' +
    'Votre entretien est confirmé :\n\n' +
    '  •  Entreprise : ' + nomEntreprise + '\n' +
    '  •  Date et heure : ' + quand + '\n' +
    '  •  Lieu : ' + (adresse || 'communiqué par téléphone') + '\n\n' +
    mentionFiche +
    'L\'entretien dure environ une heure ; merci d\'arriver quelques minutes en avance.\n' +
    'En cas d\'empêchement, prévenez-nous au plus vite.\n\n' +
    'Bonne chance !\nL\'équipe placement';

  MailApp.sendEmail({
    to: mail,
    subject: 'Confirmation d\'entretien — ' + nomEntreprise + ' — ' + quand,
    body: corps,
    attachments: pieces,
  });
  getOrCreateSheet_(CFG.SHEET_HISTORIQUE,
    ['date_action', 'etudiant', 'tel', 'entreprise', 'creneau', 'action', 'par'])
    .appendRow([new Date(), nomComplet, '', nomEntreprise, dhIso,
      'Mail de confirmation envoyé à ' + mail + (pieces.length ? ' (fiche de poste jointe)' : ''),
      Session.getActiveUser().getEmail()]);
  return { ok: true, fiche: pieces.length > 0 };
}

/** Marque un étudiant "Ne répond pas" / "Pas intéressé" / "Pas disponible" :
 *  1. trace la tentative dans HISTORIQUE (comme avant) ;
 *  2. l'enregistre dans la feuille SUIVI_APPELS — une ligne par étudiant
 *     (nom, prénom, tel), et une colonne "Entretien n" par tentative, avec le
 *     motif, l'entreprise et sa localisation.
 *  (L'exclusion de la liste des candidats est gérée côté interface.) */
function api_marquerInjoignable(nom, prenom, telEtudiant, nomEntreprise, adresseEntreprise, creneauDh, motif) {
  const complet = ((prenom || '') + ' ' + (nom || '')).trim();
  getOrCreateSheet_(CFG.SHEET_HISTORIQUE,
    ['date_action', 'etudiant', 'tel', 'entreprise', 'creneau', 'action', 'par'])
    .appendRow([new Date(), complet, telEtudiant, nomEntreprise,
      creneauDh || '', motif, Session.getActiveUser().getEmail()]);
  enregistrerSuiviAppel_(nom, prenom, telEtudiant, nomEntreprise, adresseEntreprise, creneauDh, motif);
  return { ok: true };
}

/** Écrit une tentative d'entretien dans SUIVI_APPELS.
 *  Structure : NOM | PRÉNOM | TEL | Entretien 1 | Entretien 2 | …
 *  La ligne de l'étudiant est retrouvée par téléphone (ou nom + prénom),
 *  sinon créée. La tentative va dans la première colonne "Entretien n" libre
 *  de sa ligne ; l'en-tête est créé à la volée si besoin. */
function enregistrerSuiviAppel_(nom, prenom, tel, entreprise, adresse, creneauDh, motif) {
  const sh = getOrCreateSheet_(CFG.SHEET_SUIVI, ['NOM', 'PRÉNOM', 'TEL', 'Entretien 1']);
  const data = sh.getDataRange().getValues();
  let ligne = -1;
  for (let i = 1; i < data.length; i++) {
    const memeTel = tel && String(data[i][2]).replace(/\s/g, '') === String(tel).replace(/\s/g, '');
    const memeNom = String(data[i][0]).toLowerCase().trim() === String(nom).toLowerCase().trim() &&
                    String(data[i][1]).toLowerCase().trim() === String(prenom).toLowerCase().trim();
    if (memeTel || memeNom) { ligne = i + 1; break; }
  }
  if (ligne === -1) {
    sh.appendRow([nom, prenom, "'" + tel]); // apostrophe = garder le 0 / format texte
    ligne = sh.getLastRow();
  }
  // Première colonne "Entretien n" libre sur CETTE ligne (à partir de la colonne D)
  let col = 4;
  while (String(sh.getRange(ligne, col).getValue()).trim()) col++;
  // En-tête "Entretien n" créé à la volée si la colonne n'en a pas encore
  const entete = sh.getRange(1, col);
  if (!String(entete.getValue()).trim()) {
    entete.setValue('Entretien ' + (col - 3)).setFontWeight('bold');
  }
  const d = parseDateSouple_(creneauDh);
  const quand = d ? Utilities.formatDate(d, 'Europe/Paris', 'dd/MM/yyyy HH:mm') : '';
  sh.getRange(ligne, col).setValue(
    motif + ' — ' + entreprise +
    (adresse ? ' (' + adresse + ')' : '') +
    (quand ? ' — créneau du ' + quand : ''));
}

function lireHistorique_() {
  const sh = getOrCreateSheet_(CFG.SHEET_HISTORIQUE,
    ['date_action', 'etudiant', 'tel', 'entreprise', 'creneau', 'action', 'par']);
  const data = sh.getDataRange().getValues();
  // IMPORTANT — google.script.run ne sait PAS transporter d'objets Date :
  // en renvoyer un fait échouer TOUT l'appel (l'appli ne chargeait plus dès
  // qu'une ligne existait dans HISTORIQUE). On sérialise donc en ISO.
  const iso = v => (v instanceof Date) ? v.toISOString() : String(v || '');
  return data.slice(1).reverse().map(r => ({
    date: iso(r[0]), etudiant: r[1], tel: String(r[2] || ''), entreprise: r[3],
    creneau: iso(r[4]), action: r[5], par: r[6],
  }));
}

/* ============================= UTILITAIRES ============================= */

function getOrCreateSheet_(nom, entetes) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(nom);
  if (!sh) { sh = ss.insertSheet(nom); sh.appendRow(entetes); sh.setFrozenRows(1); }
  return sh;
}

function hash_(s) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s))).slice(0, 12);
}

// ===== FIN Code.gs (v4) — si cette ligne est visible en bas du fichier, le collage est complet =====
