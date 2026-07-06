// ─── INIT ONE-TIME : à lancer manuellement une seule fois ───────────────────

function agendaInitExistingRows() {
  const agendaSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("AGENDA");
  const agendaScriptProps = PropertiesService.getScriptProperties();
  const agendaParentFolder = DriveApp.getFolderById("ENTRER_ID_DOSSIER");

  const agendaLastRow = agendaSheet.getLastRow();
  if (agendaLastRow < 2) return;

  // Un seul appel pour toutes les valeurs
  const agendaValues = agendaSheet.getRange(2, 2, agendaLastRow - 1, 2).getValues();
  const agendaNewProps = {};

  agendaValues.forEach((agendaRowData, agendaIndex) => {
    const agendaRow = agendaIndex + 2;
    const agendaColB = agendaRowData[0];
    const agendaColC = agendaRowData[1];

    if (!agendaColB && !agendaColC) return;

    const agendaPropKey = `agendaFolderRow_${agendaRow}`;
    if (agendaScriptProps.getProperty(agendaPropKey)) return;

    const agendaFolderName = `${agendaColB || "?"} - ${agendaColC || "?"}`;
    const agendaNewFolder = agendaParentFolder.createFolder(agendaFolderName);
    agendaNewProps[agendaPropKey] = agendaNewFolder.getId();
  });

  if (Object.keys(agendaNewProps).length > 0) {
    agendaScriptProps.setProperties(agendaNewProps);
  }
}


// ─── DÉCLENCHEUR : s'active à chaque modification de la feuille ─────────────

function agendaCreateOrRenameFolder(e) {
  const agendaSheet = e.source.getActiveSheet();
  if (agendaSheet.getName() !== "AGENDA") return;

  const agendaRange = e.range;
  const agendaRow = agendaRange.getRow();
  if (agendaRow <= 1) return;

  const agendaCol = agendaRange.getColumn();
  if (agendaCol !== 2 && agendaCol !== 3) return;

  const agendaColB = agendaSheet.getRange(agendaRow, 2).getValue();
  const agendaColC = agendaSheet.getRange(agendaRow, 3).getValue();

  const agendaScriptProps = PropertiesService.getScriptProperties();
  const agendaPropKey = `agendaFolderRow_${agendaRow}`;
  const agendaExistingFolderId = agendaScriptProps.getProperty(agendaPropKey);

  // B et C vides → supprimer le dossier s'il existe
  if (!agendaColB && !agendaColC) {
    if (agendaExistingFolderId) {
      try {
        DriveApp.getFolderById(agendaExistingFolderId).setTrashed(true);
      } catch (agendaErr) {
        // Dossier déjà supprimé manuellement, on ignore
      }
      agendaScriptProps.deleteProperty(agendaPropKey);
    }
    return;
  }

  const agendaFolderName = `${agendaColB || "?"} - ${agendaColC || "?"}`;
  const agendaParentFolder = DriveApp.getFolderById("ENTRER_ID_DOSSIER");

  if (agendaExistingFolderId) {
    // Dossier existant → renommer
    try {
      DriveApp.getFolderById(agendaExistingFolderId).setName(agendaFolderName);
    } catch (agendaErr) {
      // Dossier supprimé manuellement → recréer
      const agendaNewFolder = agendaParentFolder.createFolder(agendaFolderName);
      agendaScriptProps.setProperty(agendaPropKey, agendaNewFolder.getId());
    }
  } else {
    // Nouvelle ligne → créer
    const agendaNewFolder = agendaParentFolder.createFolder(agendaFolderName);
    agendaScriptProps.setProperty(agendaPropKey, agendaNewFolder.getId());
  }
}