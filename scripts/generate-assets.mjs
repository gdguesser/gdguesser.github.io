import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDirectory = new URL("../public/", import.meta.url);
const ogDirectory = new URL("../public/og/", import.meta.url);

await mkdir(fileURLToPath(ogDirectory), { recursive: true });

const ogCard = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="#c9cec4"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="#f3f1ea"/>
  <rect width="1200" height="630" fill="url(#grid)" opacity=".6"/>
  <rect x="0" width="24" height="630" fill="#155f49"/>

  <g font-family="Arial, Helvetica, sans-serif">
    <text x="82" y="86" fill="#b8461b" font-family="monospace" font-size="20" font-weight="700" letter-spacing="2">
      GUESSER.DEV / BACKEND + PLATFORM
    </text>
    <text x="82" y="208" fill="#171a16" font-size="76" font-weight="750" letter-spacing="-3">Gabriel Dietrich</text>
    <text x="82" y="294" fill="#155f49" font-size="76" font-weight="750" letter-spacing="-3">Guesser</text>
    <text x="86" y="362" fill="#555c54" font-size="30">Java, Kotlin, Spring Boot, AWS.</text>
    <text x="86" y="404" fill="#555c54" font-size="30">Kafka, PostgreSQL, Kubernetes.</text>
    <rect x="82" y="495" width="232" height="54" rx="12" fill="#155f49"/>
    <text x="111" y="530" fill="#fffdf7" font-size="22" font-weight="700">Porto, Portugal</text>
  </g>

  <g transform="translate(760 82)">
    <rect width="366" height="466" rx="28" fill="#111815"/>
    <circle cx="38" cy="38" r="6" fill="#506259"/>
    <circle cx="58" cy="38" r="6" fill="#506259"/>
    <circle cx="78" cy="38" r="6" fill="#506259"/>
    <text x="280" y="45" fill="#7ad4af" font-family="monospace" font-size="13">HEALTHY</text>
    <path d="M58 117v258" stroke="#506259" stroke-width="2"/>

    <g font-family="monospace">
      <g transform="translate(0 0)">
        <circle cx="58" cy="120" r="9" fill="#ff9d75"/>
        <rect x="88" y="91" width="228" height="58" rx="11" fill="#18231d" stroke="#506259"/>
        <text x="107" y="117" fill="#f2f4ed" font-size="15">event.accepted</text>
        <text x="107" y="137" fill="#96a198" font-size="12">durable boundary</text>
      </g>
      <g transform="translate(0 90)">
        <circle cx="58" cy="120" r="9" fill="#ff9d75"/>
        <rect x="88" y="91" width="228" height="58" rx="11" fill="#18231d" stroke="#506259"/>
        <text x="107" y="117" fill="#f2f4ed" font-size="15">outbox.committed</text>
        <text x="107" y="137" fill="#96a198" font-size="12">same transaction</text>
      </g>
      <g transform="translate(0 180)">
        <circle cx="58" cy="120" r="9" fill="#ff9d75"/>
        <rect x="88" y="91" width="228" height="58" rx="11" fill="#18231d" stroke="#506259"/>
        <text x="107" y="117" fill="#f2f4ed" font-size="15">delivery.signed</text>
        <text x="107" y="137" fill="#96a198" font-size="12">at least once</text>
      </g>
      <g transform="translate(0 270)">
        <circle cx="58" cy="120" r="9" fill="#7ad4af"/>
        <rect x="88" y="91" width="228" height="58" rx="11" fill="#18231d" stroke="#506259"/>
        <text x="107" y="117" fill="#f2f4ed" font-size="15">outcome.observed</text>
        <text x="107" y="137" fill="#96a198" font-size="12">recoverable state</text>
      </g>
    </g>
  </g>
</svg>`;

await sharp(Buffer.from(ogCard))
  .png({ compressionLevel: 9 })
  .toFile(fileURLToPath(new URL("guesser-dev.png", ogDirectory)));

const favicon = await readFile(
  fileURLToPath(new URL("../public/favicon.svg", import.meta.url)),
);

await Promise.all([
  sharp(favicon)
    .resize(32, 32)
    .png()
    .toFile(fileURLToPath(new URL("favicon-32.png", publicDirectory))),
  sharp(favicon)
    .resize(180, 180)
    .png()
    .toFile(fileURLToPath(new URL("apple-touch-icon.png", publicDirectory))),
  sharp(favicon)
    .resize(192, 192)
    .png()
    .toFile(fileURLToPath(new URL("icon-192.png", publicDirectory))),
  sharp(favicon)
    .resize(512, 512)
    .png()
    .toFile(fileURLToPath(new URL("icon-512.png", publicDirectory))),
]);

console.log(`Generated social and app assets in ${root}public`);
