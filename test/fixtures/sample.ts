// Fixture for the text-viewer e2e: a small TypeScript file with enough syntax
// variety (keywords, strings, numbers, a function) to exercise highlighting.
export interface Widget {
  id: number;
  label: string;
}

const GREETING = "hello, specterm";

export function makeWidget(id: number): Widget {
  return { id, label: `${GREETING} #${id}` };
}

for (let i = 0; i < 3; i++) {
  console.log(makeWidget(i));
}
