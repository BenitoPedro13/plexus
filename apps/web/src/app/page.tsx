import { redirect } from "next/navigation";

// No landing-page concept exists in the spec -- the editor is the app.
// This route only ever held the unedited create-next-app scaffold
// (docs/90-deferred-register.md D-39's "still-unlinked" note), so root
// sends straight to the real primary surface instead.
export default function Home() {
  redirect("/editor");
}
