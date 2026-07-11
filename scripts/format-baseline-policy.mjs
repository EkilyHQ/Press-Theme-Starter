export function evaluateBaselineTransition({ baseFiles, headFiles, changes }) {
  const baseSet = new Set(baseFiles);
  const headSet = new Set(headFiles);
  const exactRenameSources = new Map(
    changes.filter(({ status }) => status === 'R100').map(({ oldPath, newPath }) => [newPath, oldPath])
  );
  const violations = [];

  for (const file of headSet) {
    if (baseSet.has(file)) continue;
    const renameSource = exactRenameSources.get(file);
    if (!renameSource || !baseSet.has(renameSource)) {
      violations.push({ code: 'baseline-growth', file });
    }
  }

  for (const { status, oldPath, newPath } of changes) {
    if (status === 'R100') continue;
    if (!baseSet.has(oldPath)) continue;
    const retainedPath = newPath || oldPath;
    if (headSet.has(retainedPath)) {
      violations.push({
        code: 'touched-baseline-retained',
        file: retainedPath
      });
    }
  }

  return violations.sort((left, right) => `${left.code}:${left.file}`.localeCompare(`${right.code}:${right.file}`));
}

export function evaluateBootstrapBaseline({ basePaths, headFiles, changes }) {
  const baseSet = new Set(basePaths);
  const changed = new Set();
  for (const { status, oldPath, newPath } of changes) {
    if (status === 'R100') {
      changed.add(oldPath);
      changed.add(newPath);
    } else {
      changed.add(oldPath);
      changed.add(newPath);
    }
  }

  const violations = [];
  for (const file of headFiles) {
    if (!baseSet.has(file)) violations.push({ code: 'bootstrap-path-not-in-base', file });
    else if (changed.has(file)) violations.push({ code: 'bootstrap-touched-baseline-retained', file });
  }
  return violations.sort((left, right) => `${left.code}:${left.file}`.localeCompare(`${right.code}:${right.file}`));
}
