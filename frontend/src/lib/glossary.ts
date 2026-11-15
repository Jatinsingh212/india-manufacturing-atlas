/**
 * Plain-language glossary of every technical term the Atlas shows. Used by <Term> (tap/hover
 * definitions inline) and the About page. Written for officials and industry users, not economists:
 * one short "what it is" line and one "how to read it" line.
 */
export interface GlossaryEntry {
  term: string;
  /** What it is, in one sentence. */
  short: string;
  /** How to read the number (thresholds, direction). */
  read?: string;
}

export const GLOSSARY = {
  hsn: {
    term: 'HSN code',
    short: 'The product code used in customs and GST invoices. India uses 8 digits; the first 6 are the worldwide HS code.',
    read: '2 digits = chapter (e.g. 61 apparel), 4 = heading, 6 = subheading, 8 = India\'s national tariff line.',
  },
  hs6: {
    term: 'HS6',
    short: 'The 6-digit international product code. World trade statistics are published at this level.',
    read: 'Several Indian 8-digit lines can share one HS6, so they share its trade figures.',
  },
  rca: {
    term: 'RCA',
    short: 'Revealed comparative advantage: how strong India is in a product compared with its average across all exports.',
    read: 'Above 1 = India is relatively strong (2 means twice its usual share). Below 1 = relatively weak.',
  },
  world_share: {
    term: 'World share',
    short: 'India\'s exports of a product as a share of all countries\' exports of it.',
    read: 'India\'s share of all world exports is about 2%, so anything well above 2% is a strength.',
  },
  hhi: {
    term: 'Concentration (HHI)',
    short: 'How concentrated supply is in a few countries (Herfindahl-Hirschman index, 0 to 1).',
    read: 'Above 0.25 = highly concentrated; near 1 = a single country supplies almost everything.',
  },
  cagr: {
    term: 'CAGR',
    short: 'Compound annual growth rate: the average yearly growth between two years.',
    read: '+10% means the value grew on average 10% a year (it roughly doubles in 7 years).',
  },
  bcd: {
    term: 'BCD',
    short: 'Basic Customs Duty: the import tariff on a product.',
    read: 'The Atlas shows WITS applied MFN averages; no figure is shown when WITS has no ad-valorem rate.',
  },
  mfn: {
    term: 'MFN tariff',
    short: 'The standard (most-favoured-nation) import tariff applied to all WTO members without a trade deal.',
  },
  residual: {
    term: 'Residual code',
    short: 'An HSN line that no ministry owns yet - a gap in product ownership.',
    read: 'The Atlas suggests the most likely owner for each one.',
  },
  export_potential: {
    term: 'Export potential',
    short: 'A 0-100 model score of how promising a product is for growing India\'s exports.',
    read: 'Combines world market size, India\'s competitiveness (RCA), and growth of world demand and India\'s exports.',
  },
  untapped: {
    term: 'Untapped potential',
    short: 'Extra exports India would earn if it reached its usual world share in this product.',
  },
  dependency: {
    term: 'Import dependency',
    short: 'A 0-100 score of how much India relies on imports for a product.',
    read: 'High when India imports far more than it exports and buys from few countries.',
  },
  vulnerability: {
    term: 'Vulnerability',
    short: 'A 0-100 supply-chain risk score: heavy imports, few supplier countries and reliance on China.',
    read: '60 or more is flagged as a critical input.',
  },
  substitution: {
    term: 'Import substitution',
    short: 'A 0-100 score of how realistic it is to replace imports with domestic production.',
    read: 'High when imports are large, India already has some capability, and world supply is not locked up.',
  },
  archetype: {
    term: 'Archetype',
    short: 'A plain label for a product\'s position: Champion, Established, Emerging, Dependent or Marginal.',
    read: 'Champion = strong and gaining share; Dependent = imports far exceed exports.',
  },
  provenance: {
    term: 'Provenance',
    short: 'Where a number comes from and whether it is verified.',
    read: 'Green = official source (e.g. DPIIT Guidebook mapping), red = not verified (residual mapping or a model estimate), orange = not available.',
  },
  value_chain: {
    term: 'Value chain',
    short: 'The path from raw materials through components to finished goods, with the ministry responsible at each stage.',
  },
  model_estimate: {
    term: 'Model estimate',
    short: 'A score or forecast computed by the Atlas from official data, not an official statistic.',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
