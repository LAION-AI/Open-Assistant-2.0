const packagePath = new URL("../frontend/package.json", import.meta.url);
const pkg = await Bun.file(packagePath).json();
const match = String(pkg.version || "").match(/^(\d+\.\d+)\.0(?:-([a-z]+))?$/i);

if (!match) {
  throw new Error(`Expected version like 0.17.0 or 0.17.0-a, got ${pkg.version}`);
}

function nextLetters(value: string): string {
  if (!value) return "a";
  const chars = value.toLowerCase().split("");
  for (let index = chars.length - 1; index >= 0; index--) {
    if (chars[index] !== "z") {
      chars[index] = String.fromCharCode(chars[index].charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[index] = "a";
  }
  return `a${chars.join("")}`;
}

const suffix = nextLetters(match[2] || "");
pkg.version = `${match[1]}.0-${suffix}`;
await Bun.write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`v${match[1]}${suffix}`);
