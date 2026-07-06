function nettoyerDoublonsCalendrier() {
  var sheet    = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(NOM_FEUILLE);
  var lastRow  = sheet.getLastRow();
  var lastCol  = sheet.getLastColumn();
  var calendar = CalendarApp.getDefaultCalendar();

  for (var row = 2; row <= lastRow; row++) {
    var range = sheet.getRange(row, 1, 1, lastCol);
    var notes = range.getNotes()[0];

    for (var col = FIRST_BLOC + 1; col < notes.length; col += TAILLE_BLOC) {
      var eventId = notes[col];
      if (!eventId) continue;
      try {
        var event = calendar.getEventById(eventId);
        if (!event) {
          // ID orphelin, on nettoie la note
          notes[col] = "";
          Logger.log("Note orpheline nettoyée : ligne " + row + ", col " + (col + 1));
        }
      } catch(err) {
        notes[col] = "";
      }
    }
    range.setNotes([notes]);
  }
  Logger.log("Nettoyage terminé.");
}
