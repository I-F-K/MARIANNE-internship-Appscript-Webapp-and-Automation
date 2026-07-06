function coloriserLignesPreinscrits() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("PREINSCRITS 26/27");
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const COL_START = 27; // AA
  const COL_END = 38;   // AL
  const NB_COLS = COL_END - COL_START + 1;
  const NB_FULL_COLS = COL_END; // colonnes A → AL

  const values = sheet.getRange(2, COL_START, lastRow - 1, NB_COLS).getValues();
  const bgColB = sheet.getRange(2, 2, lastRow - 1, 1).getBackgrounds();
  const fullRange = sheet.getRange(2, 1, lastRow - 1, NB_FULL_COLS);

  for (let i = 0; i < values.length; i++) {

    const bg = bgColB[i][0].toLowerCase();
    // On ne retraite pas les lignes déjà colorisées (fond non blanc)
    if (bg !== "#ffffff" && bg !== "" && bg !== null) continue;

    let countRefuse = 0;
    let countPasVenu = 0;

    for (let j = 0; j < values[i].length; j++) {
      const cell = String(values[i][j]).toLowerCase().trim(); 
      if (cell.includes("refusé")) countRefuse++;             
      if (cell.includes("pas venu")) countPasVenu++;          
    }

    if (countRefuse >= 3 || countPasVenu >= 2) {
      const row = fullRange.offset(i, 0, 1, NB_FULL_COLS);
      row.setBackground("#000000");
      row.setFontColor("#ffffff");
    }
  }
}