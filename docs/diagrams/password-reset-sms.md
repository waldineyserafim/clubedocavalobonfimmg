# Redefinição de Senha via SMS (Firebase Phone Auth)

```mermaid
sequenceDiagram
    participant U as Associado
    participant R as reset_senha.html
    participant CF1 as startPasswordReset
    participant Phone as Firebase Phone Auth
    participant CF2 as completePasswordReset
    participant FS as Firestore

    U->>R: informa CPF
    R->>CF1: httpsCallable({cpf})
    CF1->>FS: rate-limit 5/hora (passwordResetAttempts/{cpf})
    CF1->>FS: busca users where cpf==X, lê telefone
    CF1-->>R: {telefoneE164}
    R->>Phone: signInWithPhoneNumber(telefoneE164, RecaptchaVerifier)
    Phone-->>U: SMS com código
    U->>R: digita código + nova senha
    R->>Phone: confirmationResult.confirm(code)
    Phone-->>R: sessão Auth temporária, claim phone_number verificado
    R->>CF2: httpsCallable({cpf, newPassword})
    CF2->>CF2: compara claim phone_number com telefone do perfil
    CF2->>FS: admin.auth().updateUser(targetUid, {password})
    CF2->>FS: primeiroAcesso:false
    CF2->>FS: apaga usuário Auth temporário
    R->>Phone: signOut
    R->>U: redireciona para login.html
```

A barreira de segurança real é o **claim `phone_number` assinado pelo Firebase** (não falsificável pelo cliente), não o CPF em si. Ver [../AUTHENTICATION.md](../AUTHENTICATION.md).
