'use strict';

const chooseButton = document.getElementById('choose-folder');
const result = document.getElementById('result');
const folderPath = document.getElementById('folder-path');

chooseButton.addEventListener('click', async () => {
  chooseButton.disabled = true;
  result.textContent = 'Waiting for folder selection and safety checks…';
  folderPath.textContent = '';

  try {
    const selection = await window.nexfixStorageQA.chooseFolder();
    if (selection.cancelled) {
      result.textContent = 'Folder selection cancelled.';
    } else {
      result.textContent = 'A new disposable QA folder and sentinel were created.';
      folderPath.textContent = selection.folderPath;
    }
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Folder selection failed safety validation.';
  } finally {
    chooseButton.disabled = false;
  }
});
