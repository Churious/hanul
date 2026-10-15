const diagnosticWindow = window as Window & { __hanulE2eErrors?: string[] };
const errors = diagnosticWindow.__hanulE2eErrors ?? [];
diagnosticWindow.__hanulE2eErrors = errors;

window.addEventListener("error", (event) => {
  errors.push(`window error: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  errors.push(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

const originalError = console.error.bind(console);
console.error = (...values: unknown[]) => {
  errors.push(`console.error: ${values.map((value) => value instanceof Error ? value.stack ?? value.message : String(value)).join(" ")}`);
  originalError(...values);
};
