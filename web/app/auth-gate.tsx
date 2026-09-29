'use client';

import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';

type Mode = 'login' | 'register' | 'recovery';

type VerificationInfo = {
  verification_id: string;
  is_user: boolean;
};

type CloudbaseAuth = Awaited<typeof import('./lib/cloudbase')>['cloudbaseAuth'];
type PasswordResetUpdater = NonNullable<
  Awaited<ReturnType<CloudbaseAuth['resetPasswordForEmail']>>['data']['updateUser']
>;

const SESSION_AUTH_KEY = 'smart-manhole-session-authenticated';

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [verificationInfo, setVerificationInfo] = useState<VerificationInfo | null>(null);
  const [verificationEmail, setVerificationEmail] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [resetCodeSent, setResetCodeSent] = useState(false);
  const authRef = useRef<CloudbaseAuth | null>(null);
  const passwordResetRef = useRef<PasswordResetUpdater | null>(null);

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setMessage('');
    setVerificationInfo(null);
    setVerificationEmail('');
    setResetEmail('');
    setResetCodeSent(false);
    passwordResetRef.current = null;
  }

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    import('./lib/cloudbase').then(async ({ cloudbaseAuth }) => {
      if (!active) return;
      authRef.current = cloudbaseAuth;
      const listener = cloudbaseAuth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          sessionStorage.removeItem(SESSION_AUTH_KEY);
          setSignedIn(false);
        }
        if (event === 'SIGNED_IN' && session && sessionStorage.getItem(SESSION_AUTH_KEY) === 'true') {
          setSignedIn(true);
        }
      });
      unsubscribe = listener.data.subscription.unsubscribe;
      const authenticatedInThisTab = sessionStorage.getItem(SESSION_AUTH_KEY) === 'true';
      if (!authenticatedInThisTab) {
        setAuthReady(true);
        return;
      }

      try {
        const { data, error } = await cloudbaseAuth.getSession();
        if (!active) return;
        setSignedIn(!error && Boolean(data?.session));
        if (error) sessionStorage.removeItem(SESSION_AUTH_KEY);
      } catch (error) {
        if (!active) return;
        sessionStorage.removeItem(SESSION_AUTH_KEY);
        setMessage(error instanceof Error ? error.message : '会话恢复失败，请重新登录');
      } finally {
        if (active) setAuthReady(true);
      }
    }).catch((error) => {
      if (!active) return;
      setMessage(error instanceof Error ? error.message : '认证服务初始化失败');
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    setSubmitting(true);
    const values = new FormData(event.currentTarget);
    const email = String(values.get('email') || '').trim();
    const password = String(values.get('password') || '');
    const invitation = String(values.get('invitation') || '').trim();
    const verificationCode = String(values.get('verificationCode') || '').trim();
    const newPassword = String(values.get('newPassword') || '');
    const confirmPassword = String(values.get('confirmPassword') || '');
    try {
      const cloudbaseAuth = authRef.current;
      if (!cloudbaseAuth) throw new Error('认证服务尚未就绪');
      if (mode === 'recovery') {
        if (!passwordResetRef.current) {
          const { data, error } = await cloudbaseAuth.resetPasswordForEmail(email);
          if (error) throw error;
          if (!data.updateUser) throw new Error('重置验证码发送失败，请稍后重试');
          passwordResetRef.current = data.updateUser;
          setResetEmail(email);
          setResetCodeSent(true);
          setMessage('6位重置验证码已发送，请查看收件箱或垃圾邮件');
          return;
        }

        if (!/^\d{6}$/.test(verificationCode)) throw new Error('请输入邮件中的6位验证码');
        if (!/^(?=.*[A-Za-z])(?=.*\d).{8,32}$/.test(newPassword)) {
          throw new Error('新密码需为8–32位，并同时包含字母和数字');
        }
        if (newPassword !== confirmPassword) throw new Error('两次输入的新密码不一致');

        const { error } = await passwordResetRef.current({
          nonce: verificationCode,
          password: newPassword,
        });
        if (error) throw error;

        sessionStorage.removeItem(SESSION_AUTH_KEY);
        await cloudbaseAuth.signOut();
        passwordResetRef.current = null;
        setResetEmail('');
        setResetCodeSent(false);
        setMode('login');
        setMessage('密码已重置，请使用新密码登录');
      } else if (mode === 'register') {
        if (!verificationInfo) {
          const inviteUrl = process.env.NEXT_PUBLIC_INVITE_CHECK_URL
            || 'https://smart-manhole-demo-d4cxwdfdf3c12.service.tcloudbase.com/api/v1/invitations/verify';
          const invitationResponse = await fetch(inviteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invitation, email }),
          });
          if (!invitationResponse.ok) throw new Error('邀请码无效');

          const verification = await cloudbaseAuth.getVerification({ email, target: 'ANY' });
          if (!verification.verification_id) throw new Error('邮箱验证码发送失败，请稍后重试');
          if (verification.is_user) {
            setMode('login');
            throw new Error('该邮箱已经注册，请直接使用密码登录');
          }
          setVerificationInfo({
            verification_id: verification.verification_id,
            is_user: Boolean(verification.is_user),
          });
          setVerificationEmail(email);
          setMessage('6位验证码已发送，请查看收件箱或垃圾邮件');
          return;
        }

        if (email !== verificationEmail) {
          setVerificationInfo(null);
          setVerificationEmail('');
          throw new Error('邮箱已修改，请重新发送验证码');
        }
        if (!/^\d{6}$/.test(verificationCode)) throw new Error('请输入邮件中的6位验证码');

        const verified = await cloudbaseAuth.verify({
          verification_id: verificationInfo.verification_id,
          verification_code: verificationCode,
        });
        if (!verified.verification_token) throw new Error('验证码校验失败，请重新获取');

        const { data, error } = await cloudbaseAuth.signUp({
          email,
          password,
          verification_token: verified.verification_token,
        });
        if (error) throw error;
        setVerificationInfo(null);
        setVerificationEmail('');
        if (data?.session) {
          sessionStorage.setItem(SESSION_AUTH_KEY, 'true');
          setSignedIn(true);
        } else {
          setMode('login');
          setMessage('注册成功，请使用邮箱和密码登录');
        }
      } else {
        const { data, error } = await cloudbaseAuth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data?.session) sessionStorage.setItem(SESSION_AUTH_KEY, 'true');
        setSignedIn(Boolean(data?.session));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  if (signedIn) {
    return <><button className="signout" type="button" onClick={async () => {
      sessionStorage.removeItem(SESSION_AUTH_KEY);
      setSignedIn(false);
      await authRef.current?.signOut();
    }}>退出登录</button>{children}</>;
  }

  return (
    <main className="auth-shell">
      <div className="auth-particles auth-particles-global" aria-hidden="true">
        {Array.from({ length: 54 }, (_, index) => (
          <span key={index} style={{
            left: `${(index * 37 + 5) % 98}%`,
            top: `${(index * 53 + 8) % 96}%`,
            animationDelay: `${-(index % 12) * 0.65}s`,
            animationDuration: `${8 + (index % 7)}s`,
          }} />
        ))}
      </div>
      <div className="auth-ambient ambient-a" aria-hidden="true" />
      <div className="auth-ambient ambient-b" aria-hidden="true" />
      <section className="auth-intro">
        <div className="auth-orbit orbit-a" aria-hidden="true" />
        <div className="auth-orbit orbit-b" aria-hidden="true" />
        <p className="eyebrow">SMART MANHOLE · INTELLIGENT MONITORING</p>
        <h1>智能井盖<br /><span>检测系统</span></h1>
        <p>融合设备定位与多传感器监测能力，实时接收 M100PG 上传数据，集中掌握井盖倾斜、水面净空与霍尔状态。</p>
        <div className="auth-device"><span className="pulse" /><strong>MH001 接收服务在线</strong><small>CloudBase · HTTPS</small></div>
      </section>
      <section className="auth-card">
        <div className="auth-tabs">
          <button type="button" className={mode === 'login' || mode === 'recovery' ? 'active' : ''} onClick={() => changeMode('login')}>密码登录</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => changeMode('register')}>邀请注册</button>
        </div>
        <h2>{mode === 'login' ? '欢迎回来' : mode === 'register' ? '创建维修人员账户' : '重置登录密码'}</h2>
        <p>{mode === 'login' ? '使用已授权的邮箱进入工作台' : mode === 'register' ? '注册后需要前往邮箱完成账户激活' : resetCodeSent ? `验证码已发送至 ${resetEmail}` : '使用注册邮箱接收密码重置验证码'}</p>
        <form onSubmit={submit}>
          <label>邮箱<input key={`${mode}-${resetCodeSent}`} type="email" name="email" autoComplete="email" required readOnly={mode === 'recovery' && resetCodeSent} defaultValue={mode === 'recovery' ? resetEmail : ''} placeholder="name@example.com" /></label>
          {mode !== 'recovery' && <label>密码<input type="password" name="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} maxLength={32} placeholder="8–32位，包含字母和数字" /></label>}
          {mode === 'login' && <button className="forgot-password" type="button" onClick={() => changeMode('recovery')}>忘记密码？</button>}
          {mode === 'register' && <label>邀请码<input type="text" name="invitation" required autoComplete="off" placeholder="请输入系统邀请码" /></label>}
          {mode === 'register' && verificationInfo && <label>邮箱验证码<input type="text" name="verificationCode" required inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} pattern="[0-9]{6}" placeholder="请输入邮件中的6位验证码" /></label>}
          {mode === 'recovery' && resetCodeSent && <>
            <label>邮箱验证码<input type="text" name="verificationCode" required inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} pattern="[0-9]{6}" placeholder="请输入邮件中的6位验证码" /></label>
            <label>新密码<input type="password" name="newPassword" autoComplete="new-password" required minLength={8} maxLength={32} placeholder="8–32位，包含字母和数字" /></label>
            <label>确认新密码<input type="password" name="confirmPassword" autoComplete="new-password" required minLength={8} maxLength={32} placeholder="请再次输入新密码" /></label>
          </>}
          {message && <p className="form-message" role="status">{message}</p>}
          <button className="auth-submit" disabled={submitting || !authReady}>{!authReady ? '正在连接认证服务…' : submitting ? '处理中…' : mode === 'login' ? '进入工作台' : mode === 'register' ? verificationInfo ? '验证并完成注册' : '发送邮箱验证码' : resetCodeSent ? '确认重置密码' : '发送重置验证码'}</button>
          {mode === 'recovery' && <div className="recovery-actions">
            <button type="button" onClick={() => changeMode('login')}>返回密码登录</button>
            {resetCodeSent && <button type="button" onClick={() => changeMode('recovery')}>重新发送验证码</button>}
          </div>}
        </form>
        <small className="privacy-note">系统不会展示或保存用户明文密码。</small>
      </section>
    </main>
  );
}
