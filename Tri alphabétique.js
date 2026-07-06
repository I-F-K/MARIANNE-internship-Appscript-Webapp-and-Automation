function TriAZ() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName("PREINSCRITS 26/27");
  
  if (sheet) {
    sheet.getRange('B:B').activate();
    sheet.sort(2, true);
    sheet.getRange('AW1').activate();
  } else {
    Logger.log("Feuille introuvable : PREINSCRITS 26/27");
  }
}