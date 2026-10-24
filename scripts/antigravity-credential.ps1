# ProjectManager native Windows credential bridge. Secrets enter via stdin, never command args.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PMAgyCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential { public uint Flags; public uint Type; public string Target; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME Modified; public uint Size; public IntPtr Blob; public uint Persist; public uint Attributes; public IntPtr Attribute; public string Alias; public string User; }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Read(string target,uint type,uint flags,out IntPtr value);
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Write(ref Credential value,uint flags);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Delete(string target,uint type,uint flags);
 public static void Remove(string target) { if(!Delete(target,1,0) && Marshal.GetLastWin32Error()!=1168) throw new Exception("Credential rollback failed"); }
 public static string Get(string target) { IntPtr p; if(!Read(target,1,0,out p)) { if(Marshal.GetLastWin32Error()==1168) return null; throw new Exception("Credential read failed"); } try { var c=(Credential)Marshal.PtrToStructure(p,typeof(Credential)); var bytes=new byte[c.Size]; Marshal.Copy(c.Blob,bytes,0,bytes.Length); return Encoding.UTF8.GetString(bytes); } finally { CredFree(p); } }
 public static void Set(string target,string raw) { var bytes=Encoding.UTF8.GetBytes(raw); var p=Marshal.AllocHGlobal(bytes.Length); try { Marshal.Copy(bytes,0,p,bytes.Length); var c=new Credential { Type=1,Target=target,Size=(uint)bytes.Length,Blob=p,Persist=2,User="antigravity" }; if(!Write(ref c,0)) throw new Exception("Credential write failed"); } finally { Marshal.FreeHGlobal(p); } }
}
'@
try {
 $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
 $target = 'gemini:antigravity'
 if ($request.operation -eq 'read') { @{ raw = [PMAgyCredential]::Get($target) } | ConvertTo-Json -Compress }
 elseif ($request.operation -eq 'write') { [PMAgyCredential]::Set($target, [string]$request.raw); '{"ok":true}' }
 elseif ($request.operation -eq 'rollback-empty') { [PMAgyCredential]::Remove($target); '{"ok":true}' }
 else { throw 'Unsupported operation' }
} catch { [Console]::Error.WriteLine('Antigravity credential store unavailable'); exit 1 }
