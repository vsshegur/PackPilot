export function groupPdfTextLines(items) {
  const points = items
    .filter(item => item.str && item.str.trim().length > 0)
    .map(item => ({
      x: item.transform[4],
      y: item.transform[5],
      str: item.str,
      width: item.width || (item.str.length * 5),
      height: item.height || Math.abs(item.transform[3]) || 9
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  const tolerance = 2.5;
  points.forEach(point => {
    let line = lines.find(candidate => Math.abs(candidate.y - point.y) < tolerance);
    if (!line) {
      line = { y: point.y, items: [] };
      lines.push(line);
    }
    line.items.push(point);
  });

  lines.forEach(line => {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
  });
  return lines.sort((a, b) => b.y - a.y);
}

export function parseMeeshoProduct(lines, fullText) {
  const headerLine = lines.find(line =>
    /\bSKU\b/i.test(line.text) && /\bSize\b/i.test(line.text) && /\bQty\b/i.test(line.text)
  );

  if (headerLine) {
    const skuHeader = headerLine.items.find(item => /^SKU$/i.test(item.str.trim()));
    const sizeHeader = headerLine.items.find(item => /^Size$/i.test(item.str.trim()));
    const qtyHeader = headerLine.items.find(item => /^Qty$/i.test(item.str.trim()));
    const colorHeader = headerLine.items.find(item => /^Colou?r$/i.test(item.str.trim()));

    if (skuHeader && sizeHeader && qtyHeader) {
      const row = lines.find(line => {
        const verticalGap = headerLine.y - line.y;
        return verticalGap > 2 && verticalGap < 38 && line.items.some(item => item.x >= skuHeader.x - 4);
      });

      if (row) {
        const sku = row.items
          .filter(item => item.x >= skuHeader.x - 4 && item.x < sizeHeader.x - 4)
          .map(item => item.str.trim())
          .join('')
          .trim();
        const qtyLimit = colorHeader ? colorHeader.x - 4 : qtyHeader.x + 70;
        const quantityText = row.items
          .filter(item => item.x >= qtyHeader.x - 8 && item.x < qtyLimit)
          .map(item => item.str)
          .join(' ');
        const quantityMatch = quantityText.match(/\b(\d{1,3})\b/);
        if (sku && !/^(SKU|Size|Qty)$/i.test(sku)) {
          return { sku, qty: quantityMatch ? Number(quantityMatch[1]) : 1 };
        }
      }
    }
  }

  const normalized = String(fullText || '').replace(/\s+/g, ' ');
  const structuredMatch = normalized.match(
    /Product\s*Details\s+SKU\s+Size\s+Qty\s+Colou?r\s+Order\s*No\.?\s+([A-Za-z0-9_.\/^+\-]{3,80})\s+(?:Free\s+Size|[A-Za-z0-9_.\/-]+)\s+(\d{1,3})\b/i
  );
  if (structuredMatch) {
    return { sku: structuredMatch[1].trim(), qty: Number(structuredMatch[2]) || 1 };
  }

  const looseMatch = normalized.match(
    /\bSKU\b[\s\S]{0,100}?\bOrder\s*No\.?\s+([A-Za-z0-9_.\/^+\-]{3,80})\s+(?:Free\s+Size|[A-Za-z0-9_.\/-]+)\s+(\d{1,3})\b/i
  );
  if (looseMatch) {
    return { sku: looseMatch[1].trim(), qty: Number(looseMatch[2]) || 1 };
  }

  return { sku: 'Unknown SKU', qty: 1 };
}

function isMeeshoBarcodeValue(value) {
  const compact = String(value || '').replace(/\s+/g, '').trim();
  if (!/^[A-Z0-9-]{10,26}$/i.test(compact)) return false;
  const digitCount = (compact.match(/\d/g) || []).length;
  return digitCount >= 6 && (/^[0-9]{12,20}$/.test(compact) || /[A-Z]/i.test(compact));
}

export function parseMeeshoBarcode(lines, fullText) {
  const productLine = lines.find(line => /Product\s*Details/i.test(line.text));
  const allItems = lines.flatMap(line => line.items || []);
  const maxX = allItems.reduce((maximum, item) => Math.max(maximum, item.x + (item.width || 0)), 0);

  if (productLine && maxX > 0) {
    const candidates = [];
    lines.forEach(line => {
      const verticalGap = line.y - productLine.y;
      if (verticalGap <= 3 || verticalGap > 190) return;
      (line.items || []).forEach(item => {
        const value = String(item.str || '').replace(/\s+/g, '').trim();
        if (item.x >= maxX * 0.44 && isMeeshoBarcodeValue(value)) {
          candidates.push({ value, verticalGap });
        }
      });
    });
    candidates.sort((a, b) => a.verticalGap - b.verticalGap || b.value.length - a.value.length);
    if (candidates.length) return candidates[0].value;
  }

  // Text-only fallback for PDFs whose individual text coordinates are absent.
  const labelSection = String(fullText || '').split(/Product\s*Details/i)[0];
  const matches = labelSection.match(/\b(?:[A-Z]{1,5}[A-Z0-9-]*\d[A-Z0-9-]{7,25}|\d{12,20})\b/gi) || [];
  const candidates = matches.map(value => value.replace(/\s+/g, '')).filter(isMeeshoBarcodeValue);
  return candidates.length ? candidates[candidates.length - 1] : '';
}

function normalizeFlipkartSku(value) {
  return String(value || '')
    .replace(/[|]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function isPlausibleFlipkartSku(value) {
  return value.length >= 3 &&
    value.length <= 100 &&
    /[A-Za-z]/.test(value) &&
    /^[A-Za-z0-9_.\/^+\-]+$/.test(value) &&
    !/^(ID|Description|QTY|Name|Price|Tax|Invoice|Amount)$/i.test(value);
}

export function parseFlipkartProduct(lines, fullText) {
  const normalizedText = String(fullText || '').replace(/\s+/g, ' ');
  const totalQtyMatch = normalizedText.match(/TOTAL\s*QTY\s*[:\-]?\s*(\d+)/i);
  const totalQty = totalQtyMatch ? Number(totalQtyMatch[1]) : null;
  const foundSkus = [];
  const addSku = value => {
    const sku = normalizeFlipkartSku(value);
    if (isPlausibleFlipkartSku(sku) && !foundSkus.includes(sku)) foundSkus.push(sku);
  };

  // The shipping-label table is the most reliable source. Unlike the tax
  // invoice, it keeps long SKUs such as MF-BLUEPATTA-ONE on one line.
  const skuHeader = lines.find(line =>
    /SKU\s*ID/i.test(line.text) && /Description/i.test(line.text) && /QTY/i.test(line.text)
  );
  if (skuHeader) {
    lines.forEach(line => {
      const verticalGap = skuHeader.y - line.y;
      if (verticalGap <= 1 || verticalGap > 105) return;
      const rowMatch = line.text.match(/^\s*\d+\s+([A-Za-z0-9_.\/^+\-]{3,100})\s*(?:\||\s{2,})/);
      if (rowMatch) addSku(rowMatch[1]);
    });
  }

  // Invoice fallback: take the value between the final product separator and
  // IMEI/SrNo, then remove PDF line-wrap whitespace inside the SKU.
  if (foundSkus.length === 0) {
    const invoicePattern = /\|\s*([A-Za-z0-9_.\/^+\-](?:[A-Za-z0-9_.\/^+\-]|\s){1,120}?)\s*\|\s*IMEI\s*\/\s*SrNo/gi;
    let match;
    while ((match = invoicePattern.exec(normalizedText)) !== null) addSku(match[1]);
  }

  // Last resort for standalone labels that expose a direct SKU/FSN field.
  if (foundSkus.length === 0) {
    const safeText = normalizedText.replace(/GSTIN\s*[:\-]?\s*[A-Z0-9]+/ig, '');
    const directMatch = safeText.match(/(?:FSN|SKU(?:\s*ID)?)\s*[:\-]?\s*([A-Za-z0-9_.\/^+\-]{3,100})/i);
    if (directMatch) addSku(directMatch[1]);
  }

  return {
    sku: foundSkus.length ? foundSkus.join(' + ') : 'Unknown SKU',
    qty: Number.isFinite(totalQty) ? totalQty : Math.max(foundSkus.length, 1)
  };
}
