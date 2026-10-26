import type { Metadata } from "next";
import { adminConfigured, isAdmin } from "@/lib/auth";
import AdminLogin from "@/components/admin-login";
import AdminDashboard from "@/components/admin-dashboard";
import "../chat.css";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Admin · Policy Knowledge Assistant",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  if (!adminConfigured()) {
    return (
      <main className="admin-center">
        <div className="login-card">
          <h1 className="read">Admin isn&apos;t set up yet</h1>
          <p>
            Add an <code>ADMIN_PASSWORD</code> environment variable in your Vercel project settings, then redeploy.
          </p>
        </div>
      </main>
    );
  }
  return (await isAdmin()) ? <AdminDashboard /> : <AdminLogin />;
}
