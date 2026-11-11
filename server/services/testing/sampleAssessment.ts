/** Small Markdown report exercising every block type the document generator supports. */
export const SAMPLE_MARKDOWN = `# RCA Migration Assessment: Acme UAT

## 1. Executive Overview & Catalog Footprint
Acme runs a **mature CPQ** implementation with *nested bundles* and a \`QCP\` script → RCA needs redesign.

| Metric | Value |
| --- | --- |
| Total Products | 3,000 |
| Active Bundles | 280 |

### Effort outlook
- **Catalog:** Medium
- Pricing: High
  - Nested item with ≥ 3 tiers
1. First phase
2. Second phase

> Note: counts come from the extraction.

\`\`\`js
export function onBeforeCalculate() {}
\`\`\`

---
Final paragraph with a [link](https://example.com).
`;
