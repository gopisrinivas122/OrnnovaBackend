const crypto = require('crypto');
const NewUser = require('../models/User');
const { comparePassword, hashPassword, isPasswordHashed } = require('../utils/password');
const { signAccessToken } = require('../utils/authToken');
const { sendPasswordResetEmail } = require('./email.service');

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000;

const buildUserSession = (user) => ({
  EmpCode: user.EmpCode,
  EmployeeName: user.EmployeeName,
  Email: user.Email,
  UserType: user.UserType,
  ProfilePic: user.ProfilePic,
  Status: user.Status,
  Id: user._id,
  ClaimedRequirements: user.claimedRequirements,
});

const login = async ({ Email, Password }) => {
  if (!Email || !Password) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Email and Password are required' },
      },
    };
  }

  const user = await NewUser.findOne({ Email: Email.trim() });

  if (!user) {
    return {
      error: {
        status: 404,
        body: { status: 'Failed', msg: 'User Does Not Exist ❌' },
      },
    };
  }

  const passwordMatches = await comparePassword(Password, user.Password);
  if (!passwordMatches) {
    return {
      error: {
        status: 401,
        body: { status: 'Failed', msg: 'Invalid Password ❌' },
      },
    };
  }

  if (user.Status === 'InActive') {
    return {
      error: {
        status: 403,
        body: { status: 'Failed', msg: 'Your account is InActive ❌' },
      },
    };
  }

  if (!isPasswordHashed(user.Password)) {
    user.Password = await hashPassword(Password);
    await user.save();
  }

  const token = signAccessToken(user);

  return {
    data: {
      status: 'Success',
      msg: 'Login Successfully ✅',
      token,
      data: buildUserSession(user),
    },
  };
};

const getLoggedInUserData = async (email) => {
  if (!email) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Email is required' },
      },
    };
  }

  const users = await NewUser.find({ Email: email }).select('-Password');
  return { data: users };
};

const sendPasswordResetLink = async (email, frontendBaseUrl) => {
  if (!email) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Email is required' },
      },
    };
  }

  const user = await NewUser.findOne({ Email: email.trim() });

  if (user) {
    const previousToken = user.token;
    const previousVerifyToken = user.verifytoken;
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.token = resetToken;
    user.verifytoken = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS).toISOString();
    await user.save();

    const resetUrl = `${frontendBaseUrl.replace(/\/$/, '')}/ResetPassword/${user._id}/${resetToken}`;
    try {
      await sendPasswordResetEmail(user, resetUrl);
    } catch (emailError) {
      user.token = previousToken;
      user.verifytoken = previousVerifyToken;
      await user.save();
      return {
        error: {
          status: 502,
          body: {
            status: 'Failed',
            msg: 'Unable to send reset email. Check EMAIL/PASSWORD in server settings (use a Gmail App Password).',
          },
        },
      };
    }
  }

  return {
    data: {
      status: 'Success',
      msg: 'If an account exists for this email, a reset link has been sent.',
    },
  };
};

const validateResetToken = async (id, token) => {
  const user = await NewUser.findById(id).select('Email verifytoken token Status');

  if (!user || !user.token || user.token !== token) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Invalid or expired reset link.' },
      },
    };
  }

  if (!user.verifytoken || new Date(user.verifytoken) < new Date()) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Reset link has expired. Please request a new one.' },
      },
    };
  }

  if (user.Status === 'InActive') {
    return {
      error: {
        status: 403,
        body: { status: 'Failed', msg: 'This account is inactive.' },
      },
    };
  }

  const maskedEmail = user.Email.replace(/(.{2})(.*)(@.*)/, (_, start, middle, domain) => {
    return `${start}${'*'.repeat(Math.max(middle.length, 3))}${domain}`;
  });

  return {
    data: {
      status: 'Success',
      email: maskedEmail,
    },
  };
};

const changePassword = async (id, token, newPassword) => {
  if (!newPassword || newPassword.length < 6) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Password must be at least 6 characters long.' },
      },
    };
  }

  const user = await NewUser.findById(id);

  if (!user || !user.token || user.token !== token) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Invalid or expired reset link.' },
      },
    };
  }

  if (!user.verifytoken || new Date(user.verifytoken) < new Date()) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Reset link has expired. Please request a new one.' },
      },
    };
  }

  user.Password = await hashPassword(newPassword);
  user.token = '';
  user.verifytoken = '';
  await user.save();

  return {
    data: {
      status: 'Success',
      msg: 'Password updated successfully. You can sign in now.',
    },
  };
};

const changePasswordForLoggedInUser = async (userId, currentPassword, newPassword) => {
  if (!currentPassword || !newPassword) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'Current password and new password are required.' },
      },
    };
  }

  if (newPassword.length < 6) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'New password must be at least 6 characters long.' },
      },
    };
  }

  if (currentPassword === newPassword) {
    return {
      error: {
        status: 400,
        body: { status: 'Failed', msg: 'New password must be different from the current password.' },
      },
    };
  }

  const user = await NewUser.findById(userId);
  if (!user) {
    return {
      error: {
        status: 404,
        body: { status: 'Failed', msg: 'User not found.' },
      },
    };
  }

  if (user.Status === 'InActive') {
    return {
      error: {
        status: 403,
        body: { status: 'Failed', msg: 'This account is inactive.' },
      },
    };
  }

  const currentMatches = await comparePassword(currentPassword, user.Password);
  if (!currentMatches) {
    return {
      error: {
        status: 401,
        body: { status: 'Failed', msg: 'Current password is incorrect.' },
      },
    };
  }

  user.Password = await hashPassword(newPassword);
  await user.save();

  return {
    data: {
      status: 'Success',
      msg: 'Password changed successfully.',
    },
  };
};

module.exports = {
  login,
  getLoggedInUserData,
  sendPasswordResetLink,
  validateResetToken,
  changePassword,
  changePasswordForLoggedInUser,
  buildUserSession,
};
