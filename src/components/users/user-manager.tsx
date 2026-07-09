"use client";
import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { KeyRound, LinkIcon, Pencil, Plus, Trash2, UserRound, X, Shield, Globe, ShieldAlert, CheckCircle2, Clock, Lock, Shuffle, Search, Copy } from "lucide-react";
import { timezoneChoices } from "@/lib/timezones";
import { toast } from "sonner";
import type { CloudPanelUser } from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";

export function UserManager({
  initialUsers,
  sites,
}: {
  initialUsers: CloudPanelUser[];
  sites: string[];
}) {
  const [users, setUsers] = useState(initialUsers);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CloudPanelUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [promptAction, setPromptAction] = useState<{ title: string; message: string; type?: string; onConfirm: (val: string) => void } | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      
      if (!result.success) throw new Error(result.error.message);
      
      const next = await fetch("/api/users").then((r) => r.json());
      setUsers(next.data.users);
      toast.success(body.action === "add" ? "User created successfully" : "User updated successfully");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operation failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const filteredUsers = useMemo(() => {
    if (!searchQuery) return users;
    const lower = searchQuery.toLowerCase();
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(lower) ||
        (u.email || "").toLowerCase().includes(lower) ||
        (u.displayName || "").toLowerCase().includes(lower) ||
        (u.role || "").toLowerCase().includes(lower)
    );
  }, [users, searchQuery]);

  return (
    <div className="mx-auto max-w-7xl space-y-8 animate-in fade-in duration-300">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">User Management</h2>
          <p className="mt-2 text-slate-500 max-w-2xl leading-relaxed">
            Manage super admins, managers, admins, and users. Admins create their own websites and only see sites assigned to them or created by them.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} className="shadow-sm">
          <Plus className="h-4 w-4 mr-2" /> Add New User
        </Button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center bg-slate-50/50">
           <div className="relative w-full sm:max-w-sm">
             <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
             <Input
               placeholder="Search users by name, email, or role..."
               className="pl-9 h-10 bg-white"
               value={searchQuery}
               onChange={e => setSearchQuery(e.target.value)}
             />
           </div>
           <div className="text-sm font-medium text-slate-500 shrink-0">
             {filteredUsers.length} {filteredUsers.length === 1 ? 'user' : 'users'} total
           </div>
        </div>

        {/* Mobile: card list with always-visible controls. */}
        <div className="divide-y divide-slate-100 md:hidden">
          {filteredUsers.map((user) => (
            <article key={user.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 rounded-full bg-panel-100 text-panel-700 flex items-center justify-center font-bold uppercase ring-1 ring-panel-500/20">
                  {user.displayName?.[0] || user.username[0]}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-slate-900">{user.displayName || user.username}</p>
                  <p className="truncate text-xs text-slate-500">{user.username}{user.email ? ` · ${user.email}` : ""}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${
                      user.panelRole === 'super-admin' ? 'bg-purple-50 text-purple-700 ring-1 ring-purple-600/20' :
                      user.panelRole === 'manager' ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-600/20' :
                      user.panelRole === 'admin' ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-600/20' :
                      'bg-slate-100 text-slate-700 ring-1 ring-slate-500/20'
                    }`}>
                      {(user.panelRole || '').replace('-', ' ')}
                    </span>
                    {user.status === false ? (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600 ring-1 ring-red-600/20">Disabled</span>
                    ) : (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600 ring-1 ring-emerald-600/20">Active</span>
                    )}
                    <span className="text-[11px] text-slate-400">
                      {user.panelRole === 'super-admin' || user.panelRole === 'manager'
                        ? 'All sites'
                        : user.sites?.length
                          ? `${user.sites.length} site${user.sites.length === 1 ? '' : 's'}`
                          : user.panelRole === 'admin' ? 'Own sites' : 'No sites'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(user)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPromptAction({
                      title: "Reset Password",
                      message: `Enter new password for ${user.username}`,
                      type: "password",
                      onConfirm: (password) => {
                        setPromptAction(null);
                        void act({ action: "reset-password", username: user.username, password });
                      }
                    });
                  }}
                >
                  <KeyRound className="h-3.5 w-3.5" /> Password
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:bg-red-50"
                  onClick={() => {
                    setConfirmAction({
                      title: "Delete User",
                      message: `Are you sure you want to delete ${user.username}? This cannot be undone.`,
                      onConfirm: () => {
                        setConfirmAction(null);
                        void act({ action: "delete", username: user.username });
                      }
                    });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </div>
            </article>
          ))}
          {filteredUsers.length === 0 && (
            <div className="px-6 py-12 text-center text-slate-500">
              <UserRound className="mx-auto h-8 w-8 mb-3 opacity-20" />
              <p>No users found matching your search</p>
            </div>
          )}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4">User</th>
                <th className="px-6 py-4">Role & Access</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredUsers.map((user) => (
                <tr key={user.id} className="group hover:bg-slate-50/50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 shrink-0 rounded-full bg-panel-100 text-panel-700 flex items-center justify-center font-bold uppercase ring-1 ring-panel-500/20">
                        {user.displayName?.[0] || user.username[0]}
                      </div>
                      <div>
                        <div className="font-semibold text-slate-900">
                          {user.displayName || user.username}
                        </div>
                        <div className="text-slate-500 text-xs mt-0.5 flex items-center gap-1.5">
                          <span>{user.username}</span>
                          <span className="text-slate-300">•</span>
                          <span>{user.email}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1.5 items-start">
                      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
                        user.panelRole === 'super-admin' ? 'bg-purple-50 text-purple-700 ring-1 ring-purple-600/20' : 
                        user.panelRole === 'manager' ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-600/20' : 
                        user.panelRole === 'admin' ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-600/20' : 
                        'bg-slate-100 text-slate-700 ring-1 ring-slate-500/20'
                      }`}>
                        {user.panelRole === 'super-admin' && <ShieldAlert className="h-3 w-3" />}
                        {user.panelRole === 'manager' && <Shield className="h-3 w-3" />}
                        {user.panelRole === 'admin' && <Shield className="h-3 w-3" />}
                        {user.panelRole === 'user' && <UserRound className="h-3 w-3" />}
                        <span className="capitalize">{(user.panelRole || '').replace('-', ' ')}</span>
                      </span>
                      <span className="text-xs text-slate-500 flex items-center gap-1">
                        <Globe className="h-3 w-3" />
                        {user.panelRole === 'super-admin' || user.panelRole === 'manager' ? 'All sites' : user.sites?.length ? `${user.sites.length} assigned sites${user.panelRole === 'admin' ? ' + own' : ''}` : user.panelRole === 'admin' ? 'Own created sites' : 'No sites assigned'}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {user.status === false ? (
                      <span className="inline-flex items-center gap-1.5 text-red-600 bg-red-50 px-2 py-1 rounded-full text-xs font-medium ring-1 ring-red-600/20">
                         Disabled
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full text-xs font-medium ring-1 ring-emerald-600/20">
                         <CheckCircle2 className="h-3 w-3" /> Active
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-slate-200/50" onClick={() => setEditing(user)} title="Edit user">
                        <Pencil className="h-4 w-4 text-slate-600" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:bg-slate-200/50"
                        title="Reset password"
                        onClick={() => {
                          setPromptAction({
                            title: "Reset Password",
                            message: `Enter new password for ${user.username}`,
                            type: "password",
                            onConfirm: (password) => {
                              setPromptAction(null);
                              void act({ action: "reset-password", username: user.username, password });
                            }
                          });
                        }}
                      >
                        <KeyRound className="h-4 w-4 text-slate-600" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:bg-red-50 hover:text-red-600 text-slate-400"
                        title="Delete user"
                        onClick={() => {
                          setConfirmAction({
                            title: "Delete User",
                            message: `Are you sure you want to delete ${user.username}? This cannot be undone.`,
                            onConfirm: () => {
                              setConfirmAction(null);
                              void act({ action: "delete", username: user.username });
                            }
                          });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center text-slate-500">
                    <div className="flex flex-col items-center justify-center">
                      <UserRound className="h-8 w-8 mb-3 opacity-20" />
                      <p>No users found matching your search</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      {open && <AddUserForm close={() => setOpen(false)} act={act} sites={sites} busy={busy} />}
      {editing && <EditUserForm user={editing} close={() => setEditing(null)} act={act} sites={sites} busy={busy} />}
      
      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          message={confirmAction.message}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {promptAction && (
        <PromptDialog
          title={promptAction.title}
          message={promptAction.message}
          type={promptAction.type}
          onConfirm={promptAction.onConfirm}
          onCancel={() => setPromptAction(null)}
        />
      )}
    </div>
  );
}

function AddUserForm({ close, act, sites, busy }: { close: () => void, act: (body: Record<string, unknown>) => Promise<boolean>, sites: string[], busy: boolean }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [autoUsername, setAutoUsername] = useState(true);
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [mode, setMode] = useState<"password" | "invite">("password");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const zones = useMemo(() => timezoneChoices(), []);

  // Auto-generate username from name if enabled
  useEffect(() => {
    if (autoUsername && (firstName || lastName)) {
      const generated = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`.replace(/[^a-z0-9.]/g, '').replace(/^\.+|\.+$/g, '');
      setUsername(generated);
    }
  }, [firstName, lastName, autoUsername]);

  function generatePassword() {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let pass = "";
    for (let i = 0; i < 16; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
    setPassword(pass);
  }

  if (inviteUrl)
    return (
      <UserModal title="Invitation created" close={close}>
        <div className="flex-1 overflow-y-auto px-6 py-8 md:px-8 bg-slate-50/50">
          <div className="mx-auto max-w-lg text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-600">
              <LinkIcon className="h-6 w-6" />
            </span>
            <h4 className="mt-5 text-xl font-bold text-slate-900">Share this link with {firstName || username}</h4>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              The account will be created with the access you defined once they open the link
              and choose their own password. Nothing is stored until then.
            </p>
            <div className="mt-6 flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <code className="min-w-0 flex-1 truncate text-left text-xs text-slate-600">{inviteUrl}</code>
              <Button
                type="button"
                size="sm"
                onClick={() => { navigator.clipboard.writeText(inviteUrl); toast.success("Invite link copied"); }}
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
            </div>
            <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-slate-400">
              <Clock className="h-3.5 w-3.5" /> The link expires in 24 hours and can only be used once.
            </p>
          </div>
        </div>
        <div className="p-4 md:px-8 border-t bg-white flex justify-end shrink-0">
          <Button type="button" onClick={close}>Done</Button>
        </div>
      </UserModal>
    );

  return (
    <UserModal title="Create New User" close={close}>
      <form
        className="flex flex-col h-full"
        onSubmit={async (event) => {
          event.preventDefault();
          if (role === "user" && selectedSites.length === 0) {
            toast.error("Please assign at least one site to this user.");
            return;
          }
          const form = new FormData(event.currentTarget);
          const body = Object.fromEntries(form);
          body.sites = selectedSites.join(",");
          if (mode === "invite") {
            setInviteBusy(true);
            try {
              const result = await fetch("/api/users", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "invite", ...body }),
              }).then((r) => r.json());
              if (!result.success) throw new Error(result.error?.message || "The invitation could not be created.");
              setInviteUrl(result.data.inviteUrl as string);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "The invitation could not be created.");
            } finally {
              setInviteBusy(false);
            }
            return;
          }
          if (await act({ action: "add", ...body })) close();
        }}
      >
        <div className="flex-1 overflow-y-auto px-6 py-6 md:px-8 bg-slate-50/50 space-y-8">
           {/* Section 1: Basic Info */}
           <div className="grid md:grid-cols-[1fr_2fr] gap-6">
             <div>
               <h4 className="text-sm font-bold text-slate-900">Personal Details</h4>
               <p className="text-xs text-slate-500 mt-1">The user&apos;s real name and contact information.</p>
             </div>
             <div className="bg-white p-5 rounded-xl border shadow-sm space-y-4">
               <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-1">
                   <Label>First Name</Label>
                   <Input name="firstName" value={firstName} onChange={e => setFirstName(e.target.value)} required placeholder="Jane" />
                 </div>
                 <div className="space-y-1">
                   <Label>Last Name</Label>
                   <Input name="lastName" value={lastName} onChange={e => setLastName(e.target.value)} required placeholder="Doe" />
                 </div>
               </div>
               <div className="space-y-1">
                 <Label>Email Address</Label>
                 <Input name="email" type="email" required placeholder="jane.doe@example.com" />
               </div>
               <div className="space-y-1">
                 <Label>Timezone</Label>
                 <select
                   name="timezone"
                   defaultValue="UTC"
                   className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-panel-500/50"
                 >
                   {zones.map((zone) => (
                     <option key={zone} value={zone}>{zone}</option>
                   ))}
                 </select>
               </div>
             </div>
           </div>

           {/* Section 2: Account Details */}
           <div className="grid md:grid-cols-[1fr_2fr] gap-6">
             <div>
               <h4 className="text-sm font-bold text-slate-900">Account Security</h4>
               <p className="text-xs text-slate-500 mt-1">Credentials used to log into CloudPanel.</p>
             </div>
             <div className="bg-white p-5 rounded-xl border shadow-sm space-y-4">
               <div className="space-y-1">
                 <Label>Username</Label>
                 <Input 
                   name="username" 
                   value={username} 
                   onChange={e => { setUsername(e.target.value); setAutoUsername(false); }} 
                   required 
                   placeholder="jane.doe" 
                   pattern="[a-zA-Z0-9.-_]+" 
                   title="Only letters, numbers, dots, hyphens, and underscores are allowed"
                 />
               </div>
               <div className="space-y-2">
                 <Label>How should the password be set?</Label>
                 <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                   <button
                     type="button"
                     onClick={() => setMode("password")}
                     className={`rounded-lg border p-3 text-left text-sm transition ${mode === "password" ? "border-panel-400 bg-panel-50" : "border-slate-200 hover:border-slate-300"}`}
                   >
                     <span className="flex items-center gap-2 font-semibold text-slate-800"><Lock className="h-4 w-4 text-panel-600" /> Set password now</span>
                     <span className="mt-1 block text-xs text-slate-500">You choose the password and share it yourself.</span>
                   </button>
                   <button
                     type="button"
                     onClick={() => setMode("invite")}
                     className={`rounded-lg border p-3 text-left text-sm transition ${mode === "invite" ? "border-panel-400 bg-panel-50" : "border-slate-200 hover:border-slate-300"}`}
                   >
                     <span className="flex items-center gap-2 font-semibold text-slate-800"><LinkIcon className="h-4 w-4 text-panel-600" /> Send an invite link</span>
                     <span className="mt-1 block text-xs text-slate-500">The user sets their own password via a 24-hour link.</span>
                   </button>
                 </div>
               </div>
               {mode === "password" && (
                 <div className="space-y-1">
                   <Label>Password</Label>
                   <div className="flex gap-2">
                     <div className="relative flex-1">
                       <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                       <Input
                         name="password"
                         type="text"
                         value={password}
                         onChange={e => setPassword(e.target.value)}
                         required
                         minLength={12}
                         placeholder="Secure password (min 12 chars)"
                         className="pl-9 font-mono text-sm"
                       />
                     </div>
                     <Button type="button" variant="outline" onClick={generatePassword} title="Generate random password" aria-label="Generate password" className="shrink-0 px-3">
                       <Shuffle className="h-4 w-4" />
                     </Button>
                     <Button type="button" variant="outline" onClick={() => { navigator.clipboard.writeText(password); toast.success("Password copied"); }} disabled={!password} title="Copy password" aria-label="Copy password" className="shrink-0 px-3">
                       <Copy className="h-4 w-4" />
                     </Button>
                   </div>
                 </div>
               )}
             </div>
           </div>

           {/* Section 3: Role & Access */}
           <div className="grid md:grid-cols-[1fr_2fr] gap-6">
             <div>
               <h4 className="text-sm font-bold text-slate-900">Role & Access</h4>
               <p className="text-xs text-slate-500 mt-1">Determine what this user can see and do.</p>
             </div>
             <div className="bg-white p-5 rounded-xl border shadow-sm space-y-5">
               <div className="space-y-1">
                 <Label>Role</Label>
                 <select
                   name="role"
                   value={role}
                   onChange={e => setRole(e.target.value)}
                   className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-panel-500/50"
                 >
                   <option value="user">User (Assigned sites only)</option>
                   <option value="admin">Admin (Creates own websites + assigned sites)</option>
                   <option value="manager">Manager (All sites, no user management)</option>
                   <option value="super-admin">Super Admin (Full access)</option>
                 </select>
               </div>
               
               {(role === 'user' || role === 'admin') && (
                 <div className="space-y-3 pt-2 border-t border-slate-100">
                   <Label>Assigned Sites</Label>
                   <div className="max-h-48 overflow-y-auto rounded-lg border bg-slate-50 p-2 space-y-1">
                     {sites.length === 0 ? (
                       <p className="text-sm text-slate-500 py-3 text-center">No sites available to assign.</p>
                     ) : (
                       sites.map((site) => (
                         <label key={site} className="flex items-center gap-3 p-2.5 rounded-md hover:bg-slate-200/50 cursor-pointer transition-colors bg-white border border-transparent hover:border-slate-200">
                           <input
                             type="checkbox"
                             checked={selectedSites.includes(site)}
                             onChange={e => {
                               if (e.target.checked) setSelectedSites([...selectedSites, site]);
                               else setSelectedSites(selectedSites.filter(s => s !== site));
                             }}
                             className="h-4 w-4 rounded border-slate-300 text-panel-600 focus:ring-panel-600"
                           />
                           <span className="text-sm font-medium text-slate-700">{site}</span>
                         </label>
                       ))
                     )}
                   </div>
                 </div>
               )}
             </div>
           </div>
        </div>

        <div className="p-4 md:px-8 border-t bg-white flex justify-end gap-3 shrink-0">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={busy || inviteBusy}>
            {mode === "invite" ? (inviteBusy ? "Creating link…" : "Create invite link") : "Create User"}
          </Button>
        </div>
      </form>
    </UserModal>
  );
}

function EditUserForm({ user, close, act, sites, busy }: { user: CloudPanelUser, close: () => void, act: (body: Record<string, unknown>) => Promise<boolean>, sites: string[], busy: boolean }) {
  const [role, setRole] = useState<string>(user.panelRole || "user");
  const [selectedSites, setSelectedSites] = useState<string[]>(user.sites || []);
  const [status, setStatus] = useState(user.status !== false);

  return (
    <UserModal title={`Edit User: ${user.username}`} close={close}>
      <form
        className="flex flex-col h-full"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await act({
              action: "update",
              username: user.username,
              role: role,
              status: status,
              sites: selectedSites,
            })
          ) close();
        }}
      >
        <div className="flex-1 overflow-y-auto px-6 py-6 md:px-8 bg-slate-50/50 space-y-8">
           {/* Section 1: Role & Access */}
           <div className="grid md:grid-cols-[1fr_2fr] gap-6">
             <div>
               <h4 className="text-sm font-bold text-slate-900">Role & Access</h4>
               <p className="text-xs text-slate-500 mt-1">Determine what this user can see and do.</p>
             </div>
             <div className="bg-white p-5 rounded-xl border shadow-sm space-y-5">
               <div className="space-y-1">
                 <Label>Role</Label>
                 <select
                   name="role"
                   value={role}
                   onChange={e => setRole(e.target.value)}
                   className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-panel-500/50"
                 >
                   <option value="user">User (Assigned sites only)</option>
                   <option value="admin">Admin (Creates own websites + assigned sites)</option>
                   <option value="manager">Manager (All sites, no user management)</option>
                   <option value="super-admin">Super Admin (Full access)</option>
                 </select>
               </div>
               
               {(role === 'user' || role === 'admin') && (
                 <div className="space-y-3 pt-2 border-t border-slate-100">
                   <Label>Assigned Sites</Label>
                   <div className="max-h-48 overflow-y-auto rounded-lg border bg-slate-50 p-2 space-y-1">
                     {sites.length === 0 ? (
                       <p className="text-sm text-slate-500 py-3 text-center">No sites available to assign.</p>
                     ) : (
                       sites.map((site) => (
                         <label key={site} className="flex items-center gap-3 p-2.5 rounded-md hover:bg-slate-200/50 cursor-pointer transition-colors bg-white border border-transparent hover:border-slate-200">
                           <input
                             type="checkbox"
                             checked={selectedSites.includes(site)}
                             onChange={e => {
                               if (e.target.checked) setSelectedSites([...selectedSites, site]);
                               else setSelectedSites(selectedSites.filter(s => s !== site));
                             }}
                             className="h-4 w-4 rounded border-slate-300 text-panel-600 focus:ring-panel-600"
                           />
                           <span className="text-sm font-medium text-slate-700">{site}</span>
                         </label>
                       ))
                     )}
                   </div>
                 </div>
               )}
             </div>
           </div>

           {/* Section 2: Account Status */}
           <div className="grid md:grid-cols-[1fr_2fr] gap-6">
             <div>
               <h4 className="text-sm font-bold text-slate-900">Account Status</h4>
               <p className="text-xs text-slate-500 mt-1">Enable or disable this account.</p>
             </div>
             <div className="bg-white p-5 rounded-xl border shadow-sm">
                <label className={`flex items-center justify-between p-4 rounded-xl border ${status ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'} cursor-pointer transition-colors`}>
                  <div>
                    <div className={`font-bold ${status ? 'text-emerald-900' : 'text-red-900'}`}>Account {status ? 'Active' : 'Disabled'}</div>
                    <div className={`text-xs mt-1 ${status ? 'text-emerald-700' : 'text-red-700'}`}>
                      {status ? 'The user can log in and access their resources.' : 'The user is blocked from logging in.'}
                    </div>
                  </div>
                  <div className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={status} onChange={e => setStatus(e.target.checked)} />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                  </div>
                </label>
             </div>
           </div>
        </div>

        <div className="p-4 md:px-8 border-t bg-white flex justify-end gap-3 shrink-0">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={busy}>Save Changes</Button>
        </div>
      </form>
    </UserModal>
  );
}

function UserModal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  // Portal to <body> so the slide-over always covers the full viewport,
  // independent of any transformed/blurred ancestor in the page layout.
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex justify-end bg-slate-950/40 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {/* Slide-over panel */}
      <div className="w-full max-w-2xl h-full bg-white shadow-2xl animate-in slide-in-from-right duration-300 flex flex-col overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-white shrink-0">
          <h3 className="text-xl font-bold text-slate-900">{title}</h3>
          <button onClick={close} className="p-1.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
