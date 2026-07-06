// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const STATUT_COLONNE  = 24; // Colonne X
const FEUILLE_SOURCE  = "PREINSCRITS 26/27";
const FEUILLE_CIBLE   = "Gestion CERFA ";
const COL_REF         = 52; // Colonne de l'ID Unique dans Gestion CERFA (52 = AZ)
const COL_ID_SOURCE   = 50; // Colonne de l'ID Unique dans PREINSCRITS (50 = AX)
const COLS_SYNC_DEBUT = 1;  // Colonne A
const COLS_SYNC_FIN   = 26; // Colonne Z -> on ne synchronise / on ne colle QUE A:Z
const COL_NOM         = 1;  // Colonne A
const COL_PRENOM      = 2;  // Colonne B

const STATUTS = {
  "vide"    : { fond: "#ffffff", texte: "#000000", copier: false },
  "à faire" : { fond: "#76e60c", texte: "#000000", copier: true  },
  "fait"    : { fond: "#b6d7a8", texte: "#000000", copier: true  }
};

// ─────────────────────────────────────────────
//  POINT D'ENTRÉE (Sécurisé avec Lock)
// ─────────────────────────────────────────────
function onEdit(e) {
  if (!e || !e.range) return;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(3000)) return;

  try {
    const sheet = e.range.getSheet();
    const nom   = sheet.getName();
    const col   = e.range.getColumn();
    const ligne = e.range.getRow();
    const ss    = sheet.getParent();

    if (nom === FEUILLE_SOURCE) {
      _gererSource(e, sheet, col, ligne, ss);
    } else if (nom === FEUILLE_CIBLE) {
      _gererCible(e, sheet, col, ligne, ss);
    }
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────────
//  CAS 1 — Modification dans PREINSCRITS
// ─────────────────────────────────────────────
function _gererSource(e, sheet, col, ligne, ss) {
  const nbCols = COLS_SYNC_FIN - COLS_SYNC_DEBUT + 1; // = 25 (A à Y)

  // ── Changement de statut ──
  if (col === STATUT_COLONNE) {

    const nouvelleValeur = sheet.getRange(ligne, STATUT_COLONNE).getValue();
    const valeur = String(nouvelleValeur).trim().toLowerCase();

    const ancienneValeur = String(e.oldValue || "").trim().toLowerCase();
    if (valeur === ancienneValeur) return;

    const config = STATUTS[valeur] || STATUTS["vide"];

    // 1. Colorier la ligne source — uniquement A:Z
    const rangeLigne = sheet.getRange(ligne, COLS_SYNC_DEBUT, 1, nbCols);
    rangeLigne.setBackground(config.fond);
    rangeLigne.setFontColor(config.texte);

    const feuilleCible = ss.getSheetByName(FEUILLE_CIBLE);

    if (!config.copier) {
      // Statut redevenu "vide" ou inconnu -> on retire la ligne cible si elle existe
      if (feuilleCible) {
        const index = _construireIndexCible(feuilleCible, nbCols);
        const nomPrenom = _cleNomPrenom(sheet, ligne);
        let idUnique = sheet.getRange(ligne, COL_ID_SOURCE).getValue();
        const cible = _resoudreCorrespondance(feuilleCible, index, idUnique, nomPrenom, nbCols);
        if (cible) feuilleCible.deleteRow(cible.ligne);
      }
      return;
    }

    // Statut "à faire" ou "fait" -> il faut synchroniser vers Gestion CERFA
    if (!feuilleCible) {
      // Pas de feuille cible -> on la crée avec l'ID s'il n'existe pas déjà
      let idUnique = sheet.getRange(ligne, COL_ID_SOURCE).getValue();
      if (!idUnique) {
        idUnique = Utilities.getUuid();
        sheet.getRange(ligne, COL_ID_SOURCE).setValue(idUnique);
      }
      const nouvelle = ss.insertSheet(FEUILLE_CIBLE);
      _insererLigne(nouvelle, sheet, ligne, nbCols, config, idUnique);
      return;
    }

    // 2. On construit UNE SEULE FOIS l'index de la feuille cible pour cette exécution
    const index = _construireIndexCible(feuilleCible, nbCols);

    let idUnique = sheet.getRange(ligne, COL_ID_SOURCE).getValue();
    const nomPrenom = _cleNomPrenom(sheet, ligne);

    // 3. Recherche robuste : par ID d'abord, puis par Nom+Prénom en repli.
    //    Si plusieurs correspondances existent (doublons), on les fusionne.
    const correspondance = _resoudreCorrespondance(feuilleCible, index, idUnique, nomPrenom, nbCols);

    if (correspondance) {
      // Ligne existante (après fusion éventuelle des doublons) → mise à jour
      if (!idUnique) {
        // L'ID manquait côté source : on récupère celui déjà présent côté cible
        idUnique = correspondance.id || Utilities.getUuid();
        sheet.getRange(ligne, COL_ID_SOURCE).setValue(idUnique);
      }
      const rangeCible = feuilleCible.getRange(correspondance.ligne, COLS_SYNC_DEBUT, 1, nbCols);
      rangeCible.setValues(rangeLigne.getValues());
      rangeCible.setBackground(config.fond);
      rangeCible.setFontColor(config.texte);
      // On s'assure que l'ID en cible est bien renseigné (cas où il manquait)
      if (!correspondance.id) {
        feuilleCible.getRange(correspondance.ligne, COL_REF).setValue(idUnique);
      }
    } else {
      // Vraiment aucune ligne correspondante -> création
      if (!idUnique) {
        idUnique = Utilities.getUuid();
        sheet.getRange(ligne, COL_ID_SOURCE).setValue(idUnique);
      }
      _insererLigne(feuilleCible, sheet, ligne, nbCols, config, idUnique);
    }

  // ── Modification d'une cellule synchronisée (hors statut) ──
  } else if (col >= COLS_SYNC_DEBUT && col <= COLS_SYNC_FIN) {
    const idUnique = sheet.getRange(ligne, COL_ID_SOURCE).getValue();
    const feuilleCible = ss.getSheetByName(FEUILLE_CIBLE);
    if (!feuilleCible) return;

    const index = _construireIndexCible(feuilleCible, nbCols);
    const nomPrenom = _cleNomPrenom(sheet, ligne);
    const correspondance = _resoudreCorrespondance(feuilleCible, index, idUnique, nomPrenom, nbCols);
    if (!correspondance) return; // Ligne pas encore synchronisée (pas de statut "à faire"/"fait")

    const valeurs = sheet.getRange(ligne, COLS_SYNC_DEBUT, 1, nbCols).getValues();
    feuilleCible.getRange(correspondance.ligne, COLS_SYNC_DEBUT, 1, nbCols).setValues(valeurs);
  }
}

// ─────────────────────────────────────────────
//  CAS 2 — Modification dans Gestion CERFA
// ─────────────────────────────────────────────
function _gererCible(e, sheet, col, ligne, ss) {
  if (col < COLS_SYNC_DEBUT || col > COLS_SYNC_FIN) return;
  if (col === STATUT_COLONNE) return;

  const idUnique = sheet.getRange(ligne, COL_REF).getValue();
  if (!idUnique) return;

  const feuilleSource = ss.getSheetByName(FEUILLE_SOURCE);
  if (!feuilleSource) return;

  const ligneSource = _trouverLigneParValeur(feuilleSource, COL_ID_SOURCE, idUnique);
  if (ligneSource < 1) return;

  const nbCols  = COLS_SYNC_FIN - COLS_SYNC_DEBUT + 1;
  const valeurs = sheet.getRange(ligne, COLS_SYNC_DEBUT, 1, nbCols).getValues();
  feuilleSource.getRange(ligneSource, COLS_SYNC_DEBUT, 1, nbCols).setValues(valeurs);
}

// ─────────────────────────────────────────────
//  UTILITAIRES — Index & résolution de correspondance
// ─────────────────────────────────────────────

// Construit en mémoire, en UNE seule lecture, l'index de la feuille cible :
//  - parId   : { "id-xxx" -> [numéros de ligne] }
//  - parNom  : { "dupont|jean" -> [numéros de ligne] }
//  - remplissage : { numéro de ligne -> nb de cellules non vides sur A:Y }
function _construireIndexCible(feuilleCible, nbCols) {
  const derniere = feuilleCible.getLastRow();
  const parId  = {};
  const parNom = {};
  const remplissage = {};

  if (derniere < 1) return { parId, parNom, remplissage };

  // Une seule lecture bloc couvrant A:AZ (jusqu'à COL_REF)
  const largeur = Math.max(nbCols, COL_REF);
  const donnees = feuilleCible.getRange(1, 1, derniere, largeur).getValues();

  for (let i = 0; i < donnees.length; i++) {
    const numLigne = i + 1;
    const id = String(donnees[i][COL_REF - 1] || "").trim();
    const nomP = _normaliser(donnees[i][COL_NOM - 1]) + "|" + _normaliser(donnees[i][COL_PRENOM - 1]);

    let nbRemplies = 0;
    for (let c = 0; c < nbCols; c++) {
      if (String(donnees[i][c] || "").trim() !== "") nbRemplies++;
    }
    remplissage[numLigne] = nbRemplies;

    if (id) {
      if (!parId[id]) parId[id] = [];
      parId[id].push(numLigne);
    }
    if (nomP !== "|") {
      if (!parNom[nomP]) parNom[nomP] = [];
      parNom[nomP].push(numLigne);
    }
  }

  return { parId, parNom, remplissage };
}

function _normaliser(valeur) {
  return String(valeur || "").trim().toLowerCase();
}

function _cleNomPrenom(sheet, ligne) {
  const nom    = sheet.getRange(ligne, COL_NOM).getValue();
  const prenom = sheet.getRange(ligne, COL_PRENOM).getValue();
  return _normaliser(nom) + "|" + _normaliser(prenom);
}

// Résout la correspondance entre une ligne source et la (ou les) ligne(s) cible(s).
// Si plusieurs lignes cibles correspondent (doublons), elles sont fusionnées immédiatement :
// on garde la plus remplie (à égalité : la ligne la plus basse = la plus récente), on
// reporte l'ID sur la ligne conservée si besoin, et on supprime les autres.
// Retourne { ligne, id } ou null si aucune correspondance.
function _resoudreCorrespondance(feuilleCible, index, idUnique, nomPrenom, nbCols) {
  idUnique = idUnique ? String(idUnique).trim() : "";

  let candidats = [];
  if (idUnique && index.parId[idUnique]) {
    candidats = index.parId[idUnique].slice();
  }
  if (candidats.length === 0 && nomPrenom !== "|" && index.parNom[nomPrenom]) {
    candidats = index.parNom[nomPrenom].slice();
  }

  if (candidats.length === 0) return null;

  if (candidats.length > 1) {
    candidats = _fusionnerDoublons(feuilleCible, index, candidats, nbCols);
  }

  const ligneFinale = candidats[0];
  const idActuel = feuilleCible.getRange(ligneFinale, COL_REF).getValue();
  return { ligne: ligneFinale, id: idActuel ? String(idActuel).trim() : "" };
}

// Fusionne un groupe de lignes en doublon : garde la plus remplie (A:Y),
// à égalité la ligne la plus basse, supprime les autres, et reporte l'ID
// le cas échéant sur la ligne conservée.
function _fusionnerDoublons(feuilleCible, index, lignesCandidates, nbCols) {
  let meilleure = lignesCandidates[0];
  for (let i = 1; i < lignesCandidates.length; i++) {
    const l = lignesCandidates[i];
    const remplL = index.remplissage[l] || 0;
    const remplM = index.remplissage[meilleure] || 0;
    if (remplL > remplM || (remplL === remplM && l > meilleure)) {
      meilleure = l;
    }
  }

  // Si la ligne conservée n'a pas d'ID mais qu'une autre en a un, on le récupère
  let idARecuperer = "";
  for (let i = 0; i < lignesCandidates.length; i++) {
    const l = lignesCandidates[i];
    const id = feuilleCible.getRange(l, COL_REF).getValue();
    if (id) { idARecuperer = String(id).trim(); break; }
  }
  const idActuelMeilleure = feuilleCible.getRange(meilleure, COL_REF).getValue();
  if (!idActuelMeilleure && idARecuperer) {
    feuilleCible.getRange(meilleure, COL_REF).setValue(idARecuperer);
  }

  // Suppression des lignes en trop, en partant de la plus basse pour ne pas
  // décaler les numéros de ligne des lignes restant à supprimer.
  const aSupprimer = lignesCandidates
    .filter(l => l !== meilleure)
    .sort((a, b) => b - a);

  for (let i = 0; i < aSupprimer.length; i++) {
    feuilleCible.deleteRow(aSupprimer[i]);
    if (aSupprimer[i] < meilleure) meilleure--; // ajuste si une ligne au-dessus a été supprimée
  }

  return [meilleure];
}

// Recherche simple par valeur dans une colonne (utilisé uniquement côté PREINSCRITS,
// qui ne souffre pas du même risque de doublon que Gestion CERFA).
function _trouverLigneParValeur(feuille, colonneRecherche, valeurRecherchee) {
  if (!valeurRecherchee) return -1;
  const derniere = feuille.getLastRow();
  if (derniere < 1) return -1;

  const valeurs = feuille.getRange(1, colonneRecherche, derniere, 1).getValues();
  const cible = String(valeurRecherchee).trim();
  for (let i = 0; i < valeurs.length; i++) {
    if (String(valeurs[i][0]).trim() === cible) return i + 1;
  }
  return -1;
}

// Insère une nouvelle ligne en bas de Gestion CERFA avec son ID Unique
function _insererLigne(feuilleCible, feuilleSource, ligneSource, nbCols, config, idUnique) {
  const valeurs     = feuilleSource.getRange(ligneSource, COLS_SYNC_DEBUT, 1, nbCols).getValues();
  const nouvellePos = feuilleCible.getLastRow() + 1;
  const rangeCible  = feuilleCible.getRange(nouvellePos, COLS_SYNC_DEBUT, 1, nbCols);

  rangeCible.setValues(valeurs);
  rangeCible.setBackground(config.fond);
  rangeCible.setFontColor(config.texte);

  feuilleCible.getRange(nouvellePos, COL_REF).setValue(idUnique);
}
