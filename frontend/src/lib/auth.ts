import "webauthn-polyfills";

export async function isPasskeySupported(): Promise<boolean> {
  if (!window.PublicKeyCredential) return false;
  try {
    const capabilities = await PublicKeyCredential.getClientCapabilities();
    return !!(capabilities.passkeyPlatformAuthenticator && capabilities.conditionalGet);
  } catch {
    return false;
  }
}

export async function registerPasskey(
  username: string,
  consent: { acceptedTerms: boolean; datasetConsent: boolean }
) {
  try {
    // Consent goes with the options request, not the verify: the server seals
    // it into the signed challenge so the choice recorded is the one made here.
    const optionsRes = await fetch("/api/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, ...consent }),
    });

    if (!optionsRes.ok) {
      const err = await optionsRes.json();
      throw new Error(err.error || "Failed to generate registration options");
    }

    const creationOptionsJSON = await optionsRes.json();
    const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(creationOptionsJSON);

    let credential;
    try {
      credential = (await navigator.credentials.create({ publicKey })) as any;
    } catch (err: any) {
      if (err.name === "InvalidStateError") {
        throw new Error("A passkey already exists for this account on this device.");
      } else if (err.name === "NotAllowedError") {
        throw new Error("Passkey creation cancelled by user.");
      } else {
        throw err;
      }
    }

    const encodedResponse = credential.toJSON();
    const verifyRes = await fetch("/api/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodedResponse),
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.json();
      // If server verification fails, signal unknown to clean up credentials store
      if (PublicKeyCredential.signalUnknownCredential) {
        try {
          await PublicKeyCredential.signalUnknownCredential({
            rpId: window.location.hostname,
            credentialId: encodedResponse.id,
          });
        } catch (signalErr) {
          console.warn("Signal API error:", signalErr);
        }
      }
      throw new Error(err.error || "Failed to verify passkey registration");
    }

    return await verifyRes.json();
  } catch (err: any) {
    console.error("Registration error:", err);
    return { error: err.message };
  }
}

// Add a passkey to the already-logged-in account (Settings → Login methods).
export async function addPasskey() {
  try {
    const optionsRes = await fetch("/api/auth/passkey/add/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!optionsRes.ok) {
      const err = await optionsRes.json();
      throw new Error(err.error || "Failed to start passkey registration");
    }
    const creationOptionsJSON = await optionsRes.json();
    const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(creationOptionsJSON);

    let credential;
    try {
      credential = (await navigator.credentials.create({ publicKey })) as any;
    } catch (err: any) {
      if (err.name === "InvalidStateError") throw new Error("This device already has a passkey for this account.");
      if (err.name === "NotAllowedError") throw new Error("Passkey creation cancelled.");
      throw err;
    }

    const encodedResponse = credential.toJSON();
    const verifyRes = await fetch("/api/auth/passkey/add/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodedResponse),
    });
    if (!verifyRes.ok) {
      const err = await verifyRes.json();
      throw new Error(err.error || "Failed to add passkey");
    }
    return await verifyRes.json();
  } catch (err: any) {
    console.error("Add passkey error:", err);
    return { error: err.message };
  }
}

export async function authenticatePasskey() {
  try {
    const optionsRes = await fetch("/api/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!optionsRes.ok) {
      const err = await optionsRes.json();
      throw new Error(err.error || "Failed to generate login options");
    }

    const loginOptionsJSON = await optionsRes.json();
    const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(loginOptionsJSON);

    let credential;
    try {
      credential = (await navigator.credentials.get({ publicKey })) as any;
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        throw new Error("Authentication cancelled by user.");
      } else {
        throw err;
      }
    }

    const encodedResponse = credential.toJSON();
    const verifyRes = await fetch("/api/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodedResponse),
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.json();
      if (verifyRes.status === 404 && PublicKeyCredential.signalUnknownCredential) {
        try {
          await PublicKeyCredential.signalUnknownCredential({
            rpId: window.location.hostname,
            credentialId: encodedResponse.id,
          });
        } catch (signalErr) {
          console.warn("Signal API error:", signalErr);
        }
      }
      throw new Error(err.error || "Failed to verify passkey login");
    }

    return await verifyRes.json();
  } catch (err: any) {
    console.error("Authentication error:", err);
    return { error: err.message };
  }
}
