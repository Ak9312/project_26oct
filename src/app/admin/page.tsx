import type { Metadata } from "next";
import { adminConfigured } from "@/lib/auth";
import AdminDashboard from "@/components/admin-dashboard";
import "../chat.css";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Admin · Policy Knowledge Assistant",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Only reachable through the secret ADMIN_PATH URL (see src/proxy.ts),
 * which also issues the admin session cookie.
 */
export default function AdminPage() {
  if (!adminConfigured()) {
    return (
      <main className="admin-center">
        <div className="login-card">
          <h1 className="read">Admin isn&apos;t set up yet</h1>
          <p>
            Add an <code>ADMIN_PATH</code> environment variable (at least 8 random characters) in your Vercel
            project settings, then redeploy. The admin page will be at that path.
          </p>
        </div>
      </main>
    );
  }
  return <AdminDashboard />;
}
