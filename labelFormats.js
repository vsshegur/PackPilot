export const LABEL_FORMAT_OPTIONS = {
  flipkart: [
    ['fk-4x6-no-inv', '4 × 6 in · label only'],
    ['fk-4x6-with-inv', '4 × 6 in · label + invoice'],
    ['fk-3x5-no-inv', '3 × 5 in · label only'],
    ['fk-3x5-with-inv', '3 × 5 in · label + invoice']
  ],
  meesho: [
    ['ms-3x5-no-inv', '3 × 5 in · label only'],
    ['ms-3x5-with-inv', '3 × 5 in · label + invoice'],
    ['ms-3x5-with-inv-store', '3 × 5 in · label + invoice + store QR'],
    ['ms-4x4-with-inv', '4 × 4 in · combined label'],
    ['ms-4x6-with-inv', '4 × 6 in · label + store QR']
  ]
};

export const DEFAULT_LABEL_FORMATS = {
  flipkart: 'fk-4x6-no-inv',
  meesho: 'ms-3x5-no-inv'
};

export function normalizeLabelFormats(value = {}) {
  return Object.fromEntries(Object.entries(LABEL_FORMAT_OPTIONS).map(([platform, options]) => {
    const allowedValues = options.map(([optionValue]) => optionValue);
    const selected = allowedValues.includes(value?.[platform])
      ? value[platform]
      : DEFAULT_LABEL_FORMATS[platform];
    return [platform, selected];
  }));
}
