const accountContractVersion = 'account-v1';

enum AccountRole { user, moderator, admin }

enum AccountSessionStatus { anonymous, authenticated }

class AccountUser {
  const AccountUser({
    required this.id,
    required this.displayName,
    required this.email,
    required this.role,
    required this.active,
    required this.onboardingVersion,
    required this.onboardingCompletedAt,
    required this.version,
  });

  final String id;
  final String displayName;
  final String email;
  final AccountRole role;
  final bool active;
  final int onboardingVersion;
  final DateTime? onboardingCompletedAt;
  final int version;

  bool get onboardingComplete => onboardingVersion == 1;

  factory AccountUser.fromJson(Object? value) {
    final map = _closedObject(value, const {
      'id',
      'display_name',
      'email',
      'role',
      'active',
      'onboarding_version',
      'onboarding_completed_at',
      'version',
    });
    final id = _nonEmptyString(map['id']);
    final displayName = _nonEmptyString(map['display_name']);
    final email = _nonEmptyString(map['email']);
    final role = switch (map['role']) {
      'user' => AccountRole.user,
      'moderator' => AccountRole.moderator,
      'admin' => AccountRole.admin,
      _ => throw const FormatException(),
    };
    final active = map['active'];
    final onboardingVersion = map['onboarding_version'];
    final rawCompletedAt = map['onboarding_completed_at'];
    final version = map['version'];
    if (active is! bool ||
        onboardingVersion is! int ||
        onboardingVersion < 0 ||
        onboardingVersion > 1 ||
        version is! int ||
        version < 1) {
      throw const FormatException();
    }
    DateTime? completedAt;
    if (rawCompletedAt != null) {
      if (rawCompletedAt is! String) throw const FormatException();
      completedAt = DateTime.tryParse(rawCompletedAt);
      if (completedAt == null) throw const FormatException();
    }
    if ((onboardingVersion == 0) != (completedAt == null)) {
      throw const FormatException();
    }
    return AccountUser(
      id: id,
      displayName: displayName,
      email: email,
      role: role,
      active: active,
      onboardingVersion: onboardingVersion,
      onboardingCompletedAt: completedAt,
      version: version,
    );
  }
}

class AccountSession {
  const AccountSession({
    required this.status,
    required this.googleLoginAvailable,
    required this.nativeLoginAvailable,
    required this.user,
  });

  final AccountSessionStatus status;
  final bool googleLoginAvailable;
  final bool nativeLoginAvailable;
  final AccountUser? user;

  factory AccountSession.fromJson(Object? value) {
    final map = _closedObject(value, const {
      'version',
      'status',
      'google_login_available',
      'native_login_available',
      'csrf_token',
      'user',
    });
    if (map['version'] != accountContractVersion || map['csrf_token'] != null) {
      throw const FormatException();
    }
    final status = switch (map['status']) {
      'anonymous' => AccountSessionStatus.anonymous,
      'authenticated' => AccountSessionStatus.authenticated,
      _ => throw const FormatException(),
    };
    final googleLoginAvailable = map['google_login_available'];
    final nativeLoginAvailable = map['native_login_available'];
    if (googleLoginAvailable is! bool || nativeLoginAvailable is! bool) {
      throw const FormatException();
    }
    final rawUser = map['user'];
    final user = rawUser == null ? null : AccountUser.fromJson(rawUser);
    if ((status == AccountSessionStatus.anonymous) != (user == null)) {
      throw const FormatException();
    }
    return AccountSession(
      status: status,
      googleLoginAvailable: googleLoginAvailable,
      nativeLoginAvailable: nativeLoginAvailable,
      user: user,
    );
  }
}

class NativeSessionExchange {
  const NativeSessionExchange({
    required this.sessionToken,
    required this.session,
  });

  final String sessionToken;
  final AccountSession session;

  factory NativeSessionExchange.fromJson(Object? value) {
    final map = _closedObject(value, const {'session_token', 'session'});
    final token = map['session_token'];
    if (token is! String ||
        token.length < 32 ||
        token.length > 512 ||
        token.contains(RegExp(r'[\s\u0000-\u001f\u007f]'))) {
      throw const FormatException();
    }
    final session = AccountSession.fromJson(map['session']);
    if (session.status != AccountSessionStatus.authenticated ||
        session.user?.active != true) {
      throw const FormatException();
    }
    return NativeSessionExchange(sessionToken: token, session: session);
  }
}

String accountRoleLabel(AccountRole role) => switch (role) {
  AccountRole.user => 'Pengguna',
  AccountRole.moderator => 'Moderator',
  AccountRole.admin => 'Administrator',
};

Map<String, Object?> _closedObject(Object? value, Set<String> expectedKeys) {
  if (value is! Map || value.length != expectedKeys.length) {
    throw const FormatException();
  }
  final map = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String || !expectedKeys.contains(entry.key)) {
      throw const FormatException();
    }
    map[entry.key as String] = entry.value;
  }
  if (!expectedKeys.every(map.containsKey)) throw const FormatException();
  return map;
}

String _nonEmptyString(Object? value) {
  if (value is! String || value.trim().isEmpty || value.length > 512) {
    throw const FormatException();
  }
  return value;
}
