const FAL_KEY_STORAGE = "ss_fal_key";

  export function getApiKey(): string | null {
    return localStorage.getItem(FAL_KEY_STORAGE);
  }

  export function setApiKey(key: string): void {
    localStorage.setItem(FAL_KEY_STORAGE, key.trim());
  }

  export function clearCredentials(): void {
    localStorage.removeItem(FAL_KEY_STORAGE);
  }

  export function hasCredentials(): boolean {
    const key = getApiKey();
    return !!key && key.length > 8;
  }
  