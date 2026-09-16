'use strict';

// Maps each compliance regime to the set of axe-core rule tags it draws from.
// A rule's `tags` array is intersected with these to decide which standards
// a given violation affects. All four regimes are anchored on WCAG success
// criteria; ADA/EAA/508 layer their own legal tags on top.
//
// axe-core tag reference: wcag2a, wcag2aa, wcag2aaa, wcag21a, wcag21aa,
// wcag22aa, section508, EN-301-549, best-practice.

const LEVEL_TAGS = {
  A:   ['wcag2a', 'wcag21a'],
  AA:  ['wcag2a', 'wcag21a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
  AAA: ['wcag2a', 'wcag21a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'wcag2aaa'],
};

// Canonical name -> { label, tags, note }. `tags` is the membership set used
// for classification; `level` controls which WCAG version/level applies.
function standardsFor(level) {
  const wcag = LEVEL_TAGS[level] || LEVEL_TAGS.AA;
  // ADA/EAA reference WCAG 2.1 AA; drop the 2.2-only tag from their membership.
  const wcag21 = wcag.filter((t) => t !== 'wcag22aa');
  return {
    WCAG: {
      label: `WCAG 2.2 Level ${level}`,
      tags: wcag,
    },
    ADA: {
      label: 'ADA Title III (WCAG 2.1 AA baseline)',
      tags: wcag21,
    },
    EAA: {
      label: 'EAA / EN 301 549 (WCAG 2.1 AA)',
      tags: ['EN-301-549', ...wcag21],
    },
    'Section 508': {
      label: 'Section 508 (WCAG 2.0 AA)',
      tags: ['section508', 'wcag2a', 'wcag2aa'],
    },
  };
}

// Normalize user input like "section508", "508", "Section 508" -> canonical key.
const ALIASES = {
  wcag: 'WCAG',
  ada: 'ADA',
  eaa: 'EAA',
  en301549: 'EAA',
  'en-301-549': 'EAA',
  section508: 'Section 508',
  '508': 'Section 508',
  s508: 'Section 508',
};

function resolveStandardKey(input) {
  const norm = String(input).trim().toLowerCase().replace(/\s+/g, '');
  return ALIASES[norm] || null;
}

module.exports = { standardsFor, resolveStandardKey, LEVEL_TAGS };
