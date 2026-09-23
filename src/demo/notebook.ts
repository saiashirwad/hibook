import type { Cell, CellKind, NotebookDocument } from "../model/types";

export const TINY_COMMERCE_IDS = {
  root: "tiny-commerce-root",
  intro: "tiny-commerce-intro",
  data: "tiny-commerce-data",
  products: "tiny-commerce-products",
  regions: "tiny-commerce-regions",
  analysis: "tiny-commerce-analysis",
  pricedProducts: "tiny-commerce-priced-products",
  metrics: "tiny-commerce-metrics",
  report: "tiny-commerce-report",
  unrelated: "tiny-commerce-unrelated",
  unrelatedVersion: "tiny-commerce-unrelated-version",
} as const;

function cell(
  id: string,
  kind: CellKind,
  name: string,
  source: string,
  children: string[] = [],
): Cell {
  return {
    id,
    kind,
    name,
    source,
    classes: [],
    metadata: {},
    children,
  };
}

const productsSource = `[
  { sku: "lamp", name: "Paper Lamp", price: 42, region: "eu" },
  { sku: "chair", name: "Low Chair", price: 125, region: "us" },
  { sku: "vase", name: "Stone Vase", price: 68, region: "eu" },
  { sku: "desk", name: "Oak Desk", price: 310, region: "us" },
];`;

const regionsSource = `({
  eu: { tax: 0.2, discount: 0.08, currency: "EUR" },
  us: { tax: 0.07, discount: 0.05, currency: "USD" },
});`;

const pricedProductsSource = `root.data.products.value.map(product => {
    const region = root.children.data.children.regions.value[product.region as keyof typeof root.children.data.children.regions.value]
    const discounted = product.price * (1 - region.discount)

    return {
      ...product,
      currency: region.currency,
      finalPrice: discounted * (1 + region.tax),
    }
  });`;

const metricsSource = `const products = parent.pricedProducts.value
const total = products.reduce(
    (sum, product) => sum + product.finalPrice,
    0,
  )

const productCount = products.length
const average = total / products.length
const mostExpensive = products.reduce((best, product) =>
      product.finalPrice > best.finalPrice ? product : best
    )`;

const reportSource = `md\`# 🛍️ Tiny Commerce Lab

We currently have **\${root.analysis.metrics.value.productCount} products**:

\${root.data.products.value.map(product => \`**\${product.name}**\`).join(" · ")}

**Average-price-o-meter:** \${"▰".repeat(Math.round(root.analysis.metrics.value.average / 25))}
**\${root.analysis.metrics.value.average.toFixed(2)}**

The heavyweight champion is
**\${root.analysis.metrics.value.mostExpensive.name.toUpperCase()}**
at **\${root.analysis.metrics.value.mostExpensive.finalPrice.toFixed(2)}
\${root.analysis.metrics.value.mostExpensive.currency}**.
\``;

export const TINY_COMMERCE_NOTEBOOK: NotebookDocument = {
  rootId: TINY_COMMERCE_IDS.root,
  cells: {
    [TINY_COMMERCE_IDS.root]: cell(
      TINY_COMMERCE_IDS.root,
      "text",
      "tinyCommerce",
      "Tiny Commerce Lab",
      [
        TINY_COMMERCE_IDS.intro,
        TINY_COMMERCE_IDS.data,
        TINY_COMMERCE_IDS.analysis,
        TINY_COMMERCE_IDS.report,
        TINY_COMMERCE_IDS.unrelated,
      ],
    ),
    [TINY_COMMERCE_IDS.intro]: cell(
      TINY_COMMERCE_IDS.intro,
      "text",
      "introduction",
      "A deterministic reactive notebook: edit structure by name, then watch only the affected computation path run again.",
    ),
    [TINY_COMMERCE_IDS.data]: cell(
      TINY_COMMERCE_IDS.data,
      "text",
      "data",
      "Commerce data",
      [TINY_COMMERCE_IDS.products, TINY_COMMERCE_IDS.regions],
    ),
    [TINY_COMMERCE_IDS.products]: cell(
      TINY_COMMERCE_IDS.products,
      "javascript",
      "products",
      productsSource,
    ),
    [TINY_COMMERCE_IDS.regions]: cell(
      TINY_COMMERCE_IDS.regions,
      "javascript",
      "regions",
      regionsSource,
    ),
    [TINY_COMMERCE_IDS.analysis]: cell(
      TINY_COMMERCE_IDS.analysis,
      "text",
      "analysis",
      "Reactive analysis",
      [TINY_COMMERCE_IDS.pricedProducts, TINY_COMMERCE_IDS.metrics],
    ),
    [TINY_COMMERCE_IDS.pricedProducts]: cell(
      TINY_COMMERCE_IDS.pricedProducts,
      "javascript",
      "pricedProducts",
      pricedProductsSource,
    ),
    [TINY_COMMERCE_IDS.metrics]: cell(
      TINY_COMMERCE_IDS.metrics,
      "javascript",
      "metrics",
      metricsSource,
    ),
    [TINY_COMMERCE_IDS.report]: cell(
      TINY_COMMERCE_IDS.report,
      "markdown",
      "report",
      reportSource,
    ),
    [TINY_COMMERCE_IDS.unrelated]: cell(
      TINY_COMMERCE_IDS.unrelated,
      "text",
      "unrelated",
      "Independent branch",
      [TINY_COMMERCE_IDS.unrelatedVersion],
    ),
    [TINY_COMMERCE_IDS.unrelatedVersion]: cell(
      TINY_COMMERCE_IDS.unrelatedVersion,
      "javascript",
      "branchVersion",
      '({ branch: "unrelated", version: 1 })',
    ),
  },
};
