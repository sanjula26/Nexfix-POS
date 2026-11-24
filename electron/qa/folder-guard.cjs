'use strict';

function isPathWithin(pathApi, candidate, parent) {
  const relative = pathApi.relative(parent, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + pathApi.sep) &&
    !pathApi.isAbsolute(relative)
  );
}

/**
 * Reject a selected QA data folder if it overlaps a protected location.
 * Callers must pass canonical/real paths (after fs.realpath) for both the
 * candidate and protected roots. Rejecting both containment directions also
 * prevents selecting a parent such as a drive root that contains live data.
 */
function assertOutsideProtectedPaths(candidate, protectedRoots, pathApi = require('node:path')) {
  if (typeof candidate !== 'string' || !candidate.trim() || !pathApi.isAbsolute(candidate)) {
    throw new Error('Choose an absolute disposable QA folder.');
  }
  const resolvedCandidate = pathApi.normalize(candidate);
  const parsed = pathApi.parse(resolvedCandidate);
  if (resolvedCandidate === parsed.root) {
    throw new Error('A drive root cannot be used as a disposable QA folder.');
  }
  if (!Array.isArray(protectedRoots) || protectedRoots.length === 0) {
    throw new Error('Protected POS storage locations are required.');
  }

  for (const protectedRoot of protectedRoots) {
    if (typeof protectedRoot !== 'string' || !protectedRoot.trim() || !pathApi.isAbsolute(protectedRoot)) {
      throw new Error('A protected POS storage location could not be validated.');
    }
    const resolvedProtected = pathApi.normalize(protectedRoot);
    if (isPathWithin(pathApi, resolvedCandidate, resolvedProtected) ||
        isPathWithin(pathApi, resolvedProtected, resolvedCandidate)) {
      throw new Error('The selected QA folder overlaps a protected POS, Windows, or application location.');
    }
  }
  return resolvedCandidate;
}

module.exports = { assertOutsideProtectedPaths };
