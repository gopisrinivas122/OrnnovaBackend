const express = require('express');
const multer = require('multer');
const authController = require('../controllers/auth.controller');

const router = express.Router();
const upload = multer();

router.post('/login', upload.none(), authController.login);
router.post('/sendpasswordlink', upload.none(), authController.sendPasswordLink);
router.get('/ResetPasswordpage/:id/:token', authController.validateResetPasswordPage);
router.post('/Changepassword/:id/:token', upload.none(), authController.changePassword);

module.exports = router;
