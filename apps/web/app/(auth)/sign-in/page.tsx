import { SignInForm } from "../../../components/domain/SignInForm.tsx";

/**
 * Wallet-signature sign-in page (UI-1, F1, F8).
 * Renders the NEP-413 sign-in interface supporting both browser wallet extensions
 * and direct CLI testnet credentials.
 */
export default function SignInPage() {
  return <SignInForm />;
}
