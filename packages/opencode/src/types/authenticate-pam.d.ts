declare module "authenticate-pam" {
  export function authenticate(username: string, password: string, cb: (err: Error | null) => void): void;
}
