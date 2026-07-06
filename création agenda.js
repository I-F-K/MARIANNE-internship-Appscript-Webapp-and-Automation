var NOM_FEUILLE = "AGENDA";

// --- CONSTANTES COULEURS ---
var COULEURS_SHEETS = {
  "Accepté":    { fond: "#51b749", texte: "#202124" },
  "En attente": { fond: "#fbd75b", texte: "#202124" },
  "Refusé":     { fond: "#dc2127", texte: "#202124" },
  "Pas venu":   { fond: "#ff6d00", texte: "#202124" },
  "Absence justifiée": { fond: "#ffb878", texte: "#202124" }
};

var COULEURS_AGENDA = {
  "Accepté":    CalendarApp.EventColor.GREEN,
  "En attente": CalendarApp.EventColor.YELLOW,
  "Refusé":     CalendarApp.EventColor.RED,
  "Pas venu":   CalendarApp.EventColor.ORANGE,
  "Absence justifiée": CalendarApp.EventColor.PALE_RED
};

// ← NOUVEAU : couleurs des états "partiels" (date seule vs bloc complet sans statut)
var COULEUR_AGENDA_RESERVE  = CalendarApp.EventColor.GRAY; // date/heure seule, pas de nom
var COULEUR_AGENDA_SANS_STATUT = CalendarApp.EventColor.TEAL;  // nom présent mais pas de statut

// --- NOUVEAU : table inverse couleur Calendar (code numérique) → statut ---
// Les codes numériques sont ceux utilisés par CalendarApp.EventColor / Calendar API.
// On construit la table à partir de COULEURS_AGENDA pour rester cohérent avec le sens Sheets→Agenda.
var COULEUR_VERS_STATUT = (function() {
  var table = {};
  for (var statut in COULEURS_AGENDA) {
    table[COULEURS_AGENDA[statut]] = statut;
  }
  return table;
})();

var TAILLE_BLOC = 3;
var FIRST_BLOC  = 8;

var COULEUR_COMPLET = "#51b749";

// Préfixe utilisé pour stocker, dans la note de la cellule "eleve" (col),
// la couleur que LE SCRIPT a posée sur l'événement en dernier.
// Cela permet, lors du scan périodique, de distinguer :
//  - une couleur Agenda qui correspond toujours à ce que le script a posé (rien à faire)
//  - une couleur Agenda modifiée manuellement par un humain (à remonter vers la feuille)
var PREFIXE_COULEUR_ATTENDUE = "lastColor:";

// --- MISE À JOUR DES COLONNES G ET H + COLORISATION A→H ---
function updateIndicateurs(sheet, row, data, nbPersonnes) {
  var nbBlocsComplets = 0;
  var nbAcceptes      = 0;

  for (var col = FIRST_BLOC; col + TAILLE_BLOC - 1 < data.length; col += TAILLE_BLOC) {
    var eleve     = data[col];
    var dateHeure = data[col + 1];
    var statut    = data[col + 2];

    if (eleve !== "" && dateHeure !== "") {
      nbBlocsComplets++;
    }
    if (statut === "Accepté") {
      nbAcceptes++;
    }
  }

  var denominateur = (nbPersonnes !== "" && !isNaN(nbPersonnes) && Number(nbPersonnes) > 0)
                     ? Number(nbPersonnes)
                     : "?";

  sheet.getRange(row, 7).setValue(nbAcceptes + "/" + denominateur);
  sheet.getRange(row, 8).setValue(nbBlocsComplets);

  var rangeAH = sheet.getRange(row, 1, 1, 8);
  var estPlein = (typeof denominateur === "number" && nbAcceptes >= denominateur);

  if (estPlein) {
    rangeAH.setBackground(COULEUR_COMPLET);
    rangeAH.setFontColor("#000000");
  } else {
    rangeAH.setBackground(null);
    rangeAH.setFontColor(null);
  }
}

function onEditInstallable(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== NOM_FEUILLE) return;

  var row = e.range.getRow();
  if (row === 1) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    Logger.log("Verrou non obtenu, édition ignorée : " + err.message);
    return;
  }

  try {
    var editStartCol = e.range.getColumn() - 1;
    var editEndCol   = editStartCol + e.range.getNumColumns() - 1;

    var lastCol  = sheet.getLastColumn();
    var maxCol   = sheet.getMaxColumns();

    var lastColIndex   = lastCol > 0 ? lastCol - 1 : 0;
    var maxIndexToRead = Math.max(lastColIndex, editEndCol);

    if (maxIndexToRead < FIRST_BLOC) {
      if (lastColIndex < FIRST_BLOC) {
        var rowData     = sheet.getRange(row, 1, 1, Math.max(lastCol, 6)).getValues()[0];
        var nbPersonnes = rowData[5];
        updateIndicateurs(sheet, row, [], nbPersonnes);
        return;
      }
      maxIndexToRead = lastColIndex;
    }

    var colonnesBlocs      = maxIndexToRead - FIRST_BLOC + 1;
    var nbBlocs            = Math.ceil(colonnesBlocs / TAILLE_BLOC);
    var totalColumnsToRead = FIRST_BLOC + (nbBlocs * TAILLE_BLOC);
    totalColumnsToRead     = Math.min(totalColumnsToRead, maxCol);

    var range       = sheet.getRange(row, 1, 1, totalColumnsToRead);
    var data        = range.getValues()[0];
    var notes       = range.getNotes()[0];
    var backgrounds = range.getBackgrounds()[0];
    var fontColors  = range.getFontColors()[0];

    var entretien   = data[0];
    var entreprise  = data[1];
    var lieu        = data[2];
    var contact     = data[3];
    var nbPersonnes = data[5];

    var calendar        = CalendarApp.getDefaultCalendar();
    var notesToUpdate   = false;
    var formatsToUpdate = false;

    for (var col = FIRST_BLOC; col + TAILLE_BLOC - 1 < data.length; col += TAILLE_BLOC) {
      var blockEndCol         = col + TAILLE_BLOC - 1;
      var isGeneralInfoEdited = (editStartCol < FIRST_BLOC);
      var isThisBlockEdited   = (editEndCol >= col && editStartCol <= blockEndCol);

      if (!isGeneralInfoEdited && !isThisBlockEdited) continue;

      var eleve     = data[col];
      var dateHeure = data[col + 1];
      var statut    = data[col + 2];
      var eventId   = notes[col + 1];

      // --- SUPPRESSION : date effacée → on supprime tout ---
      if (dateHeure === "" && eventId) {
        try {
          var eventToDelete = calendar.getEventById(eventId);
          if (eventToDelete) eventToDelete.deleteEvent();
        } catch(err) {}

        notes[col + 1] = "";
        notes[col]     = ""; // ← NOUVEAU : on nettoie aussi la couleur attendue stockée
        notesToUpdate = true;

        for (var i = 0; i < TAILLE_BLOC; i++) {
          backgrounds[col + i] = null;
          fontColors[col + i]  = null;
        }
        formatsToUpdate = true;
        continue;
      }

      // ← NOUVEAU : si eleve vide et date présente mais pas de date valide → skip
      if (dateHeure === "") continue;
      if (!(dateHeure instanceof Date)) continue;

      // --- CONSTRUCTION DE L'ÉVÉNEMENT ---
      var debut = new Date(dateHeure);
      var fin   = new Date(debut.getTime() + 60 * 60 * 1000);

      // ← NOUVEAU : titre et couleur varient selon que le nom est renseigné ou non
      var estReserve = (eleve === "");
      var titre = estReserve
                  ? "— A pourvoir — (" + entreprise + ")"
                  : entreprise + " — " + eleve;

      var desc  = "Entretien : " + entretien
                + "\nContact : "  + contact
                + "\nLieu : "     + lieu
                + "\nNombre de personnes : " + nbPersonnes;

      var event = null;
      if (eventId) {
        try { event = calendar.getEventById(eventId); } catch(err) {}
      }

      if (event) {
        event.setTitle(titre);
        event.setTime(debut, fin);
        event.setDescription(desc);
        event.setLocation(lieu);
      } else {
        event = calendar.createEvent(titre, debut, fin, {
          description: desc,
          location: lieu
        });
        notes[col + 1] = event.getId();
        notesToUpdate = true;
      }

      // --- COULEUR AGENDA + FOND SHEETS ---
      var couleurPoseeSurEvent = null; // ← NOUVEAU : pour mémoriser ce qu'on vient de poser

      if (statut && COULEURS_SHEETS[statut]) {
        // Cas 3 : statut renseigné → couleur du statut
        var couleurSheet = COULEURS_SHEETS[statut];
        for (var i = 0; i < TAILLE_BLOC; i++) {
            backgrounds[col + i] = couleurSheet.fond;
            fontColors[col + i]  = couleurSheet.texte;
        }
        formatsToUpdate = true;
        try {
          event.setColor(COULEURS_AGENDA[statut]);
          couleurPoseeSurEvent = COULEURS_AGENDA[statut];
        } catch(err) {}

      } else if (eleve !== "") {
        // Cas 2 : nom + date, pas de statut → Teal
        for (var i = 0; i < TAILLE_BLOC; i++) {
          backgrounds[col + i] = null;
          fontColors[col + i]  = null;
        }
        formatsToUpdate = true;
        try {
          event.setColor("7"); // 7 = Teal/Paon
          couleurPoseeSurEvent = "7";
        } catch(err) {}

      } else {
        // Cas 1 : date seule, pas de nom → Gray
        for (var i = 0; i < TAILLE_BLOC; i++) {
          backgrounds[col + i] = null;
          fontColors[col + i]  = null;
        }
        formatsToUpdate = true;
        try {
          event.setColor("8"); // 8 = Graphite/Gris
          couleurPoseeSurEvent = "8";
        } catch(err) {}
      }

      // ← NOUVEAU : on mémorise la couleur posée par le script dans la note
      // de la cellule "eleve" (col), pour pouvoir la comparer plus tard lors
      // du scan périodique et détecter une modification manuelle dans Calendar.
      if (couleurPoseeSurEvent !== null) {
        notes[col] = PREFIXE_COULEUR_ATTENDUE + couleurPoseeSurEvent;
        notesToUpdate = true;
      }
    }

    if (notesToUpdate)   range.setNotes([notes]);
    if (formatsToUpdate) {
      range.setBackgrounds([backgrounds]);
      range.setFontColors([fontColors]);
    }

    updateIndicateurs(sheet, row, data, nbPersonnes);

  } finally {
    try {
      synchroniserPersonnes();
    } catch (err) {
      Logger.log("Erreur synchronisation PREINSCRITS : " + err.message);
    }
    lock.releaseLock();
  }
}

// ============================================================
// NOUVEAU : SYNCHRONISATION AGENDA → SHEETS (couleur → statut)
// ============================================================
//
// Principe :
// - Cette fonction est destinée à être appelée par un trigger temporel
//   (toutes les 30 minutes, cf. installerTriggerSyncAgendaVersSheets()).
// - Pour chaque bloc (eleve / dateHeure / statut) de chaque ligne de la
//   feuille AGENDA, on relit l'eventId stocké en note (col+1) et la
//   "couleur attendue" stockée en note (col), c'est-à-dire la dernière
//   couleur que LE SCRIPT a posée sur l'événement.
// - On compare cette couleur attendue à la couleur ACTUELLE de l'événement
//   dans Calendar :
//     * Si elles sont identiques → rien n'a été modifié manuellement,
//       on ne touche à rien.
//     * Si elles diffèrent ET que la couleur actuelle correspond à un
//       statut connu (table COULEUR_VERS_STATUT) → on considère que la
//       couleur a été changée manuellement dans Google Agenda.
//       Dans ce cas :
//         - On vérifie que le statut actuellement en feuille correspond
//           bien à la couleur attendue stockée (c'est-à-dire que la
//           feuille n'a pas, elle, été modifiée entre-temps). Si la feuille
//           a divergé de la couleur attendue, c'est qu'un humain a édité la
//           feuille directement : conformément à la règle "la feuille fait
//           foi", on ignore le changement détecté côté Agenda et on laisse
//           la feuille telle quelle (elle sera re-synchronisée vers
//           l'agenda au prochain onEdit).
//         - Sinon (la feuille est toujours alignée avec ce que le script
//           avait posé), on met à jour le statut en feuille avec le
//           nouveau statut déduit de la couleur, puis on déclenche la
//           resynchronisation complète du bloc (recalcul des couleurs
//           Sheets, des indicateurs, etc.) comme le ferait onEditInstallable.
//
// NB : Calendar ne déclenche aucun trigger natif lors d'un changement de
// couleur manuel ; cette fonction doit donc être appelée périodiquement
// (polling), il n'existe pas d'alternative simple sans passer par les
// Push Notifications de l'API Calendar avancée (watch channels).
function synchroniserCouleursAgendaVersSheets() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(NOM_FEUILLE);
  if (!sheet) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    Logger.log("Verrou non obtenu, synchro Agenda→Sheets ignorée : " + err.message);
    return;
  }

  try {
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < FIRST_BLOC) return;

    var calendar = CalendarApp.getDefaultCalendar();

    var range       = sheet.getRange(2, 1, lastRow - 1, lastCol);
    var allData     = range.getValues();
    var allNotes    = range.getNotes();
    var allBg       = range.getBackgrounds();
    var allFontCol  = range.getFontColors();

    var rangeModifiee = false;

    for (var r = 0; r < allData.length; r++) {
      var data        = allData[r];
      var notes       = allNotes[r];
      var backgrounds = allBg[r];
      var fontColors  = allFontCol[r];
      var sheetRow    = r + 2;

      var entreprise  = data[1];
      var lieu        = data[2];
      var nbPersonnes = data[5];

      var ligneModifiee = false;

      for (var col = FIRST_BLOC; col + TAILLE_BLOC - 1 < data.length; col += TAILLE_BLOC) {
        var eventId = notes[col + 1];
        if (!eventId) continue;

        var eleve        = data[col];
        var dateHeure     = data[col + 1];
        var statutActuel = data[col + 2];

        var noteEleve = notes[col] || "";
        if (noteEleve.indexOf(PREFIXE_COULEUR_ATTENDUE) !== 0) continue; // pas de couleur attendue connue
        var couleurAttendue = noteEleve.substring(PREFIXE_COULEUR_ATTENDUE.length);

        var event = null;
        try { event = calendar.getEventById(eventId); } catch(err) {}
        if (!event) continue;

        var couleurActuelle;
        try { couleurActuelle = event.getColor(); } catch(err) { continue; }
        // getColor() renvoie "" (chaîne vide) pour la couleur par défaut du calendrier
        if (!couleurActuelle) continue;

        // Rien n'a changé côté Agenda par rapport à ce que le script a posé
        if (couleurActuelle === couleurAttendue) continue;

        // La couleur a changé manuellement dans Calendar : on regarde si
        // elle correspond à un statut connu.
        var nouveauStatut = COULEUR_VERS_STATUT[couleurActuelle];
        if (!nouveauStatut) continue; // couleur non reconnue (ex: Teal/Gray) → on ignore

        // Règle "la feuille fait foi" : on ne remonte le changement Agenda→Sheets
        // que si la feuille n'a pas elle-même divergé de ce que le script avait
        // posé en dernier (sinon, l'édition manuelle de la feuille est prioritaire
        // et sera de toute façon re-synchronisée vers Calendar au prochain onEdit).
        var statutAttenduEnFeuille = couleurVersStatutAttenduEnFeuille(couleurAttendue);
        var feuilleEstAJour = (statutActuel === statutAttenduEnFeuille) ||
                               (statutAttenduEnFeuille === null && (statutActuel === "" || statutActuel == null));

        if (!feuilleEstAJour) {
          // La feuille a été modifiée entre-temps par un humain → elle fait foi, on ignore Calendar.
          continue;
        }

        if (statutActuel === nouveauStatut) continue; // déjà aligné, rien à faire

        // --- Mise à jour du statut en feuille à partir de la couleur Calendar ---
        data[col + 2] = nouveauStatut;

        var couleurSheet = COULEURS_SHEETS[nouveauStatut];
        for (var i = 0; i < TAILLE_BLOC; i++) {
          backgrounds[col + i] = couleurSheet.fond;
          fontColors[col + i]  = couleurSheet.texte;
        }

        // On met aussi à jour la couleur attendue stockée, puisque le script
        // "valide" maintenant cette couleur comme étant la couleur de référence.
        notes[col] = PREFIXE_COULEUR_ATTENDUE + couleurActuelle;

        // On réaligne le titre/description de l'événement comme le ferait onEditInstallable,
        // pour rester cohérent (ex: si le nom était vide, etc. — ici eleve est déjà défini).
        try {
          var titre = (eleve === "")
                      ? "— A pourvoir — (" + entreprise + ")"
                      : entreprise + " — " + eleve;
          event.setTitle(titre);
        } catch(err) {}

        ligneModifiee  = true;
        rangeModifiee  = true;
      }

      if (ligneModifiee) {
        updateIndicateurs(sheet, sheetRow, data, nbPersonnes);
      }
    }

    if (rangeModifiee) {
      range.setValues(allData);
      range.setNotes(allNotes);
      range.setBackgrounds(allBg);
      range.setFontColors(allFontCol);
    }

  } finally {
    lock.releaseLock();
  }
}