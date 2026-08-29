export class BindingError extends Error {
  public constructor(public readonly commandId: string) {
    super(`command binding mismatch: ${commandId}`);
    this.name = "BindingError";
  }
}

export class SpoolStateError extends Error {
  public constructor(
    public readonly commandId: string,
    state: string,
  ) {
    super(`invalid spool state for ${commandId}: ${state}`);
    this.name = "SpoolStateError";
  }
}

export class AuthenticationError extends Error {
  public constructor() {
    super("cloud relay authentication failed");
    this.name = "AuthenticationError";
  }
}
