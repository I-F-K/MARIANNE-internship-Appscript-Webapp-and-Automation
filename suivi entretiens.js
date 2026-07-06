/**
 * ===================================================================
 * SYNCHRONISATION FEUILLE "PREINSCRITS 26/27"
 * ===================================================================
 * Ce fichier dépend des constantes suivantes, définies dans le fichier
 * principal du projet (ex: Code.gs) :
 *   - NOM_FEUILLE  (nom de la feuille AGENDA)
 *   - FIRST_BLOC   (index 0-based de la 1ère colonne de bloc, = 8)
 *   - TAILLE_BLOC  (nombre de colonnes par bloc, = 3)
 * Première utilisation : lancer synchroniserPersonnes() manuellement
 * depuis l'éditeur Apps Script pour remplir la feuille avec les
 * données déjà existantes dans AGENDA.
 * ===================================================================
 */
var NOM_FEUILLE_PERSONNES   = "PREINSCRITS 26/27";
var COL_NOM_PERSONNE        = 2;  // colonne B
var COL_PRENOM_PERSONNE     = 3;  // colonne C
var COL_PREMIER_ENTRETIEN   = 27; // colonne AA
var COL_DERNIER_ENTRETIEN   = 38; // colonne AL
var LIGNE_ENTETE_PERSONNES  = 1;  // 1 ligne d'en-tête, données dès la ligne 2

// Normalise une chaîne : majuscules, sans accents, espaces multiples réduits
function normaliser(str) {
  if (!str) return "";
  return str.toString()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase()
            .replace(/\s+/g, " ")
            .trim();
}

// Parcourt AGENDA et renvoie la liste de tous les entretiens (un par bloc rempli)
function collecterEntretiensAgenda() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(NOM_FEUILLE);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < FIRST_BLOC) return [];

  var data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var entretiens = [];

  for (var r = 1; r < data.length; r++) { // r=0 -> ligne d'en-tête, on l'ignore
    var row = data[r];
    var entreprise = row[1]; // colonne B = entreprise

    for (var col = FIRST_BLOC; col + TAILLE_BLOC - 1 < row.length; col += TAILLE_BLOC) {
      var eleve     = row[col];
      var dateHeure = row[col + 1];
      var statut    = row[col + 2];

      if (eleve && dateHeure instanceof Date) {
        entretiens.push({
          nomNormalise: normaliser(eleve),
          date: dateHeure,
          entreprise: entreprise,
          lieu: row[2], // colonne C = lieu
          statut: statut
        });
      }
    }
  }

  return entretiens;
}

// Remplit les colonnes "Entretien" (AA -> AL) de PREINSCRITS 26/27, par ordre chronologique
function synchroniserPersonnes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var feuillePersonnes = ss.getSheetByName(NOM_FEUILLE_PERSONNES);
  if (!feuillePersonnes) return;

  var lastRowPersonnes = feuillePersonnes.getLastRow();
  var lastColPersonnes = feuillePersonnes.getLastColumn();
  if (lastRowPersonnes <= LIGNE_ENTETE_PERSONNES) return;

  var derniereColEntretien = Math.min(lastColPersonnes, COL_DERNIER_ENTRETIEN);
  var nbColEntretiens = derniereColEntretien - COL_PREMIER_ENTRETIEN + 1;
  if (nbColEntretiens <= 0) return; // pas de colonnes "Entretien" -> rien à faire

  var entretiensAgenda = collecterEntretiensAgenda();
  var fuseauHoraire = ss.getSpreadsheetTimeZone();

  var nbLignesPersonnes = lastRowPersonnes - LIGNE_ENTETE_PERSONNES;
  var nomsPrenoms = feuillePersonnes
      .getRange(LIGNE_ENTETE_PERSONNES + 1, COL_NOM_PERSONNE, nbLignesPersonnes, 2)
      .getValues();

  var sortie = [];

  for (var i = 0; i < nomsPrenoms.length; i++) {
    var nom    = normaliser(nomsPrenoms[i][0]);
    var prenom = normaliser(nomsPrenoms[i][1]);

    var ligneSortie = new Array(nbColEntretiens).fill("");

    if (nom || prenom) {
      var entretiensPersonne = entretiensAgenda.filter(function(e) {
        return (!nom    || e.nomNormalise.indexOf(nom)    !== -1)
            && (!prenom || e.nomNormalise.indexOf(prenom) !== -1);
      });

      entretiensPersonne.sort(function(a, b) {
        return a.date.getTime() - b.date.getTime();
      });

      for (var j = 0; j < entretiensPersonne.length && j < nbColEntretiens; j++) {
        var e = entretiensPersonne[j];
        var dateFormatee = Utilities.formatDate(e.date, fuseauHoraire, "dd/MM/yyyy HH:mm");
        var elements = [e.entreprise, e.lieu, dateFormatee, e.statut];

        ligneSortie[j] = elements
          .filter(function(valeur) { return valeur !== "" && valeur !== null && valeur !== undefined; })
          .join(" - ");
      }
    }

    sortie.push(ligneSortie);
  }

  feuillePersonnes
    .getRange(LIGNE_ENTETE_PERSONNES + 1, COL_PREMIER_ENTRETIEN, sortie.length, nbColEntretiens)
    .setValues(sortie);
}