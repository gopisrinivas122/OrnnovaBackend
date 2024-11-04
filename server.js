const express= require("express");
const cors = require("cors");
const router = express.Router();
const mongoose = require("mongoose");
const multer=require("multer");
const { type } = require("os");
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const { error } = require("console");
const jwt = require('jsonwebtoken');
const nodemailer=require('nodemailer');
const { inflate } = require("zlib");
const { truncate } = require("fs");
dotenv.config()

// email Config

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth:{
        user:process.env.EMAIL,
        pass:process.env.PASSWORD
    }
})

const path = require('path');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, 'uploads/');
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + path.extname(file.originalname));
        }
    }),
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|pdf/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Invalid file type'));
    }
});


const app =express();
app.use(express.json());


// Define allowed origins
const allowedOrigins = [
  'https://frontend-fge2.vercel.app', 
  'https://frontend-theta-mocha-38.vercel.app'
];

// Configure CORS options
const corsOptions = {
  origin: function (origin, callback) {
    // Check if the origin is allowed
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,  // Allow cookies to be sent
};

// Apply CORS middleware
app.use(cors(corsOptions));

  
app.use("/www", express.static("uploads"));
app.use('/uploads', express.static('uploads'));
app.listen(process.env.PORT,()=>{
    console.log("Listening to Port 7993");
});

let ConnectedtoMDB= async()=>{
    try{
        await mongoose.connect("mongodb+srv://OrnnovaHRMangement:OrnnovaHRMangement@ornnovahrmanagment.qu6ub6f.mongodb.net/HRManagment?retryWrites=true&w=majority&appName=OrnnovaHRManagment");
        console.log("Succesfuly Connected to MDB ✅");
    }catch{
        console.log("Failed to Connect to MDB ❌");
    }
}
 ConnectedtoMDB();
 
 let userSchema = new mongoose.Schema({
    EmpCode: {
        type: String,
        required: true,
    },
    EmployeeName: {
        required: true,
        type: String,
    },
    Email: {
        required: true,
        type: String,
    },
    Password: {
        required: true,
        type: String,
    },
    UserType: {
        required: true,
        type: String,
    },
    ProfilePic: {
        type: String,
    },
    Status: {
        type: String,
    },
    verifytoken: {
        type: String,
    },
    token: {
        type: String,
    },
    CreatedBy: {
        type: String,
    },
    Team: [
        { 
            type:String
        }
    ],
    Clients: [
        {
            type: mongoose.Schema.Types.ObjectId,  // Use ObjectId if you are working with ObjectIds
            ref: 'Client' // Replace 'Client' with the actual reference model name if needed
        }
    ],
    Requirements:[
        {
          type:mongoose.Schema.Types.ObjectId,
          ref: 'Requirements'
        }
    ],
    claimedRequirements: [{ type: mongoose.Schema.Types.ObjectId, ref: "NewRequirement" }]
});

 let NewUser = new mongoose.model("Users",userSchema);

 app.get("/loggedinuserdata/:email",async(req,res)=>{
    
    let loggedinuserdata = await NewUser.find({Email:req.params.email})
    res.json(loggedinuserdata);
 })

app.post("/newUser",upload.array("ProfilePic"),async(req,res)=>{

    let userArr=await NewUser.find().and({Email:req.body.Email});
    if (userArr.length>0) {
        res.json({status:"failure",msg:"Email already Exist❌"});
    }else{
    try{
        let newUser = new NewUser({          
            EmpCode:req.body.EmpCode,
            EmployeeName:req.body.EmployeeName,
            Email:req.body.Email,
            Password:req.body.Password,
            UserType:req.body.UserType,
            ProfilePic:req.files[0].path,
            Status:req.body.Status,
            token:req.body.Token,
            CreatedBy:req.body.CreatedBy,
            Team:req.body.Team

        });
        await newUser.save();
        res.json({status:"Success",msg:" User Created Successfully✅"});
    }catch(error){
        res.json({status:"Failed",error:error,msg:"Invalid Details ❌"});
        console.log(error)
    }
    }
}
);
app.get("/userDetailsHome",async(req,res)=>{ 
    // to get only usertype having only user 
    // let userDetailshome=await NewUser.find({UserType:"User"});
    let userDetailshome=await NewUser.find();
    res.json(userDetailshome);
})
// Assign Clients to Users
app.get('/userDetailstoAssignClient/:clientId', async (req, res) => {
    const clientId = req.params.clientId;

    try {
        // Find users who do not have the specified client ID in their Clients array
        const userDetails = await NewUser.find({
            UserType: { $in: ["User", "TeamLead"] },
            Clients: { $ne: clientId }  // $ne operator excludes users with the clientId in Clients array
        });

        // Get the count of users
        const count = userDetails.length;

        // Now, to get the count of users for each clientId in the Clients array
        const clientCounts = await NewUser.aggregate([
            { $unwind: "$Clients" },  // Deconstruct the Clients array
            { $group: {
                _id: "$Clients",  // Group by clientId
                userCount: { $sum: 1 },  // Count the number of users for each clientId
                users: { $push: "$$ROOT" }  // Push the entire user document
            }},
            { $lookup: {
                from: 'clients',  // The name of the collection for clients (adjust if necessary)
                localField: '_id',
                foreignField: '_id',
                as: 'clientInfo'  // Join client info based on clientId
            }},
            { $unwind: "$clientInfo" },  // Optional: to flatten the client info
            { $project: {
                _id: 0,  // Exclude the default _id
                clientId: "$_id",  // Include the clientId
                userCount: 1,
                users: 1,
                clientName: "$clientInfo.name"  // Assuming the Client schema has a name field
            }}
        ]);

        res.json({ count, userDetails, clientCounts });
    } catch (error) {
        res.status(500).json({ message: "Server Error", error });
    }
});

app.get('/userDetailsofAssignedClient/:clientId', async (req, res) => {
    const clientId = req.params.clientId;
    
    try {
        // Find users who do not have the specified client ID in their Clients array
        const userDetails = await NewUser.find({
            UserType: { $in: ["User", "TeamLead"] },
            Clients: { $in: clientId }  // $ne operator excludes users with the clientId in Clients array
        });
 // Get the count of users
 const count = userDetails.length;

 res.json({ count, userDetails });
    } catch (error) {
        res.status(500).json({ message: "Server Error", error });
    }
});

// Assign Requirement to Users
app.get('/userDetailstoAssignRequirement/:reqId/:userId', async (req, res) => {
    const { reqId, userId } = req.params;
   
    try {
        // Find the user with the provided userId to get their team members
        const user = await NewUser.findById(userId);
        
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Get the user's Team array (assuming it's an array of user IDs)
        const teamIds = user.Team; // This is an array of user IDs

        // If the user has no team, return an empty array for team members
        if (!teamIds || teamIds.length === 0) {
            return res.json({ teamMembers: [], requirementDetails: null });
        }

        // Find the team members who do not have the specified reqId in their Requirements array
        const teamMembers = await NewUser.find({
            _id: { $in: teamIds }, // Filter users whose IDs are in the Team array
            UserType: { $in: ["User"] }, // Ensure UserType is "User"
            Requirements: { $ne: reqId }  // Exclude users who already have this reqId in their Requirements array
        });

        // Find the requirement details using the reqId from the NewRequirement schema
        const requirementDetails = await NewRequirment.findById(reqId);
        
        if (!requirementDetails) {
            return res.status(404).json({ message: "Requirement not found" });
        }

        // Return both team members and the requirement details
        res.json({ teamMembers, requirementDetails });
    } catch (error) {
        res.status(500).json({ message: "Server Error", error });
    }
});

app.get('/userDetailsofAssignedRequirement/:reqId/:userId', async (req, res) => {
    const reqId = req.params.reqId;
    const userId = req.params.userId;

    try {
        // Step 1: Find the user to get their Team array
        const user = await NewUser.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const teamIds = user.Team; // Get the Team array

        // Step 2: Find users in the Team who have the specified reqId in their Requirements
        const userDetails = await NewUser.find({
            UserType: { $in: ["User"] },
            Requirements: reqId, // Users with the specified reqId
            _id: { $in: teamIds } // Users present in the Team
        });

        res.json(userDetails);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error });
    }
});
// Route to get users with UserType 'User'
app.get("/getUserDataToADDtoTeam", async (req, res) => {
    try {
        // Step 1: Get the list of all userIds that are in any Team array
        const usersWithTeams = await NewUser.find({ "Team": { $exists: true, $ne: [] } }, "Team");

        // Extract all the userIds from the Team arrays
        let userIdsInTeams = usersWithTeams.flatMap(user =>
            user.Team
                .filter(id => id) // Ensure id is defined
                .map(id => id.toString())
        );

        // Filter out any empty or invalid ObjectId strings
        userIdsInTeams = userIdsInTeams.filter(id => id && mongoose.Types.ObjectId.isValid(id));

        // Query to get users where UserType is 'User' and their _id is not in the Team array
        const userDetails = await NewUser.find({
            UserType: "User",
            _id: { $nin: userIdsInTeams }
        });

        // Respond with the filtered user details as JSON
        res.json(userDetails);
    } catch (err) {
        // Handle errors (e.g., database issues)
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

app.post("/login", upload.none(), async (req, res) => {
    console.log(req.body);

    // Fetch user data based on the email provided
    let fetchedData = await NewUser.find({ Email: req.body.Email });
    console.log(fetchedData);

    // Check if the user exists
    if (fetchedData.length > 0) {
        // Validate the password
        if (fetchedData[0].Password === req.body.Password) {
            // Prepare data to send back
            let dataToSend = {
                EmpCode: fetchedData[0].EmpCode,
                EmployeeName: fetchedData[0].EmployeeName,
                Email: fetchedData[0].Email,
                UserType: fetchedData[0].UserType, // UserType retrieved from database
                ProfilePic: fetchedData[0].ProfilePic,
                Status: fetchedData[0].Status,
                Id: fetchedData[0]._id,
                ClaimedRequirements: fetchedData[0].claimedRequirements,
                Token: fetchedData[0].tokenVersion
            };
            res.json({ status: "Success", msg: "Login Successfully ✅", data: dataToSend });
        } else {
            res.json({ status: "Failed", msg: "Invalid Password ❌" });
        }
    } else {
        res.json({ status: "Failed", msg: "User Does Not Exist ❌" });
    }
});

const secretKey = process.env.SECRET_KEY;

app.post("/sendpasswordlink",async (req,res)=>{
    console.log(req.body);
    const {email} = req.body;

    if (!email) {
        res.status(401).json({status:401,message:"Enter Your Email"})
    }
    try {
        const userfind = await NewUser.findOne({Email:email});
        
        // token generate for reset password

        const token = jwt.sign({_id:userfind._id},secretKey,{expiresIn:"300s"});
        
        const setusertoken = await NewUser.findByIdAndUpdate({_id:userfind._id},{verifytoken:token},{new:true});
         
        if (setusertoken) {
            const mailOptions = {
                from:process.env.EMAIL,
                to:email,
                subject:"Password Reset Link",
                text:`This link is valid for 5minutes http://localhost:3000/ResetPassword/${userfind.id}/${setusertoken.verifytoken}`
            }

            transporter.sendMail(mailOptions,(error,info)=>{
                if(error){
                    console.log("Error",error);
                    res.status(401).json({status:401,message:"Email Not Send"})
                }else{
                    console.log("Email Sent",info.response);
                    res.status(201).json({status:201,message:"Email Sent Successfully"})
                }
            })
        }
        
    } catch (error) {
        res.status(401).json({status:401,message:"Invalid User"})

    }
})
//  verify user for forgot password

app.get("/ResetPasswordpage/:id/:token",async(req,res)=>{
    const {id,token} = req.params;
    try {
        const validuser = await NewUser.findOne({_id:id,verifytoken:token});
        const verifyToken = jwt.verify(token,secretKey);
        console.log(verifyToken)
        if (validuser && verifyToken._id){
             res.status(201).json({status:201,validuser})
        }else{
            res.status(401).json({status:401,message:"User Not Exist"})

        }
    } catch (error) {
        res.status(401).json({status:401,error })

    }
})
//  Change Password
app.post("/:id/:token",async(req,res)=>{
    const {id,token} = req.params;
    const{password} = req.body;
    try{
        const validuser = await NewUser.findOne({_id:id,verifytoken:token});
        const verifyToken = jwt.verify(token,secretKey);

        if (validuser && verifyToken._id) {
            // const newpassword = await bcrypt.hash(password,12);
            const newpassword = await (password);
            const setnewuserpass = await NewUser.findByIdAndUpdate({_id:id},{Password:newpassword})
         setnewuserpass.save();
         res.status(201).json({status:201,setnewuserpass})
        }else{
            res.status(401).json({status:401,message:"User Not Exist"})

        }
    }catch(error){
        res.status(401).json({status:401,error })
    }
})

app.delete("/deleteUser/:id",async(req,res)=>{
    console.log(req.params.id);
    try {
      await NewUser.deleteMany({_id:req.params.id});
    res.json({status:"success",msg:`User Deleted Successfully✅`});
    } catch (error) {
      res.json({status:"failure",msg:"Unable To Delete ❌",error:error});
    }
    
   });

app.get("/getUserData/:id", async (req, res) => {
    try {
        // Find the user by the given ID
        const user = await NewUser.findById(req.params.id);

        if (!user) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // Extract the Team array (which contains user IDs)
        const teamUserIds = user.Team;

        // Find the details of all users whose IDs are in the Team array
        const teamUserDetails = await NewUser.find({ _id: { $in: teamUserIds } });

        // Combine user data and team details into a single response object
        const response = {
            userDetails: user,
            teamDetails: teamUserDetails
        };

        // Respond with the combined user and team details
        res.json(response);
    } catch (err) {
        console.error("Error fetching user data:", err);
        res.status(500).json({ msg: "Internal Server Error" });
    }
});

 app.get("/getUserdatatoUpdate/:id",async(req,res)=>{
    let userdetails = await NewUser.findById({_id:req.params.id});
    res.json(userdetails); 
 }) 
// Assuming you are using Express and Mongoose
app.put('/updateUser/:id', async (req, res) => {
    const { id } = req.params;
    const { name, Code, email, status, usertype, profile, Team } = req.body;

    try {
        // Fetch the current user
        const currentUser = await NewUser.findById(id);

        if (!currentUser) {
            return res.status(404).json({ msg: 'User not found' });
        }

        // Merge new team members with existing ones if usertype is "TeamLead"
        const teamObjectIds = usertype === "TeamLead" 
            ? Array.from(new Set([
                ...currentUser.Team, // Existing team members
                ...Team.map(userId => new mongoose.Types.ObjectId(userId)) // New team members
            ]))
            : currentUser.Team; // No change if usertype is not "TeamLead"

        // Update user
        const updatedUser = await NewUser.findByIdAndUpdate(
            id,
            { 
                EmployeeName: name,
                EmpCode: Code,
                Email: email,
                Status: status,
                UserType: usertype,
                ProfilePic: profile,
                Team: teamObjectIds // Correctly set Team
            },
            { new: true } // Return the updated document
        );

        if (updatedUser) {
            res.json({ msg: 'User updated successfully', updatedUser });
        } else {
            res.status(404).json({ msg: 'User not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ msg: 'Error updating user' });
    }
});

let clientSchema= new mongoose.Schema({
    ClientCode:{
        required:true,
        type:String,
        unique:true,
    },
  
    ClientName:{
        required:true,
         type:String,
    },
    Services:{
        required:true,
        type:String,    
    },
    Location:{
        required:true,
        type:String,
    },
    Name:{
        // required:true,
        type:String,
    },
    Spoc:{
        // required:true,
        type:String,
    },
    MobileNumber:{
        // required:true,
        type:Number,
    },
    Email:{
        // required:true,
        type:String,
    },
    Name1:{
        type:String,
    },
    Spoc1:{
        type:String,
    },
    MobileNumber1:{
        type:Number,
    },
    Email1:{
        type:String,
    },
    Name2:{
        type:String,
    },
    Spoc2:{
        type:String,
    },
    MobileNumber2:{
        type:Number,
    },
    Email2:{
        type:String,
    },
    Assign:[
        {
            type:String,
        }
    ]
 });

 let NewClient = new mongoose.model("Clients",clientSchema);

 app.post("/addClient",upload.none(),async(req,res)=>{ 
    let ClientArr=await NewClient.find().and({ClientCode:req.body.ClientCode});
    if (ClientArr.length>0) {
        res.json({status:"failure",msg:"Client Code already Exist❌"});
    }else{
    try{
        let newClient = new NewClient({
          ClientCode:req.body.ClientCode,
          ClientName:req.body.ClientName,
          Services:req.body.Services,
          Location:req.body.Location,
          Name:req.body.Name,
          Spoc:req.body.Spoc,
          MobileNumber:req.body.MobileNumber,
          Email:req.body.Email, 
          Name1:req.body.Name1,
          Spoc1:req.body.Spoc1,
          MobileNumber1:req.body.MobileNumber1,
          Email1:req.body.Email1,
          Name2:req.body.Name2,
          Spoc2:req.body.Spoc2,
          MobileNumber2:req.body.MobileNumber2,
          Email2:req.body.Email2,
          
        });
        await newClient.save();
        console.log(req.body);
        res.json({status:"Success",msg:" Client Created Successfully✅"});
    }catch(error){
        res.json({status:"Failed",error:error,msg:"Invalid Details ❌"});
        console.log(error);       
    }
    }
}
);

// app.get("/ClientsList",async(req,res)=>{
//     let ClientsList = await NewClient.find();
//     res.json(ClientsList);
// })

app.get("/ClientsList", async (req, res) => {
    try {
        const clientsList = await NewClient.find();

        const clientUserCounts = [];

        for (const client of clientsList) {
            // Find users for the current client and filter by userType
            const users = await NewUser.find({
                Clients: client._id,
            });

            const userCount = users.length;

            // Count users of type 'user' and 'teamlead'
            const allusers = await NewUser.find({
                UserType: { $in: ['User', 'TeamLead'] }
            } );
            let allusersCount = allusers.length;
            
            clientUserCounts.push({
                clientId: client._id,
                clientCode: client.ClientCode, // Ensure this field exists in your schema
                clientName: client.ClientName, // Ensure this field exists in your schema
                userCount: userCount, // Total user count
                userTypeCounts:allusersCount, // Count of specific user types
                clientDetails: {
                    location: client.Location,
                    typeOfService: client.Services,
                }
            });
        }

        res.json({ clientUserCounts }); // Ensure this is returned correctly
    } catch (error) {
        res.status(500).json({ message: "Server Error", error });
    }
});

app.get("/allUsersCount",async(req,res)=>{
    try{
        // Count users of type 'user' and 'teamlead'
        const allusers = await NewUser.find({
            UserType: { $in: ['User', 'TeamLead'] }
        } );
        let allusersCount = allusers.length;
        res.json(allusersCount); 
        
    } catch(err){
        console.log(err);
    }
})


app.get("/ClientsList/:id",async(req,res)=>{
    let ClientsList = await NewClient.find({_id:req.params.id});
    res.json(ClientsList);
})

app.get("/clientDetails",async(req,res)=>{   
    let clientdetails = await NewClient.find();
    res.json(clientdetails);
})

app.delete("/deleteClient/:id",async(req,res)=>{
    console.log(req.params.id);
    try {
      await NewClient.deleteMany({_id:req.params.id});
    res.json({status:"success",msg:`Client Deleted Successfully✅`});
    } catch (error) {
      res.json({status:"failure",msg:"Unable To Delete ❌",error:error});
    }
    
   });

 app.get("/getClientdatatoUpdate/:id",async(req,res)=>{
    let clientdetails = await NewClient.findById({_id:req.params.id});
    res.json(clientdetails); 
 })  
app.put("/UpdateClient/:id", async(req,res)=>{
    console.log(req.params.id);
    try {
        if(req.body.ClientCode.length>0){
          await NewClient.updateOne({_id:req.body.id},
            {ClientCode:req.body.ClientCode});
        }
        if(req.body.ClientName.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {ClientName:req.body.ClientName});
          }
          if(req.body.Services.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Services:req.body.Services});
          }
          if(req.body.Location.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Location:req.body.Location});
          }
          if(req.body.Email.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Email:req.body.Email});
          }
          if(req.body.Email1.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Email1:req.body.Email1});
          }
          if(req.body.Email2.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Email2:req.body.Email2});
          }
          if(req.body.MobileNumber.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {MobileNumber:req.body.MobileNumber});
          }
          if(req.body.MobileNumber1.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {MobileNumber1:req.body.MobileNumber1});
          }
          if(req.body.MobileNumber2.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {MobileNumber2:req.body.MobileNumber2});
          }
          if(req.body.Name.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Name:req.body.Name});
          }
          if(req.body.Name1.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Name1:req.body.Name1});
          }
          if(req.body.Name2.length>0){
            await NewClient.updateOne({_id:req.body.id},
              {Name2:req.body.Name2});
          }
          if(req.body.Spoc.length>0){
            await NewClient.updateOne({_id:req.body.id},
              { Spoc:req.body. Spoc});
          }
          if(req.body.Spoc1.length>0){
            await NewClient.updateOne({_id:req.body.id},
              { Spoc1:req.body. Spoc1});
          }
          if(req.body.Spoc2.length>0){
            await NewClient.updateOne({_id:req.body.id},
              { Spoc2:req.body. Spoc2});
          }
        res.json({status:"success",msg:" Details Updated Successfully✅"});
        
      } catch (error) {
        res.json({status:"failure",msg:"Didn't Updated all ☹️"});
        console.log(error);
      }
})

const RequirementSchema = new mongoose.Schema({
    regId: {
        type: String,
        required: true
    },
    client: {
        type: String,
        required: true
    },
    typeOfContract: {
        type: String,
        required: true
    },
    startDate: {
        type: Date,
        required: true
    },
    duration: {
        type: String,
        required: true
    },
    location: {
        type: String,
        required: true
    },
    sourceCtc: {
        type: String,
        required: true
    },
    qualification: {
        type: String,
        required: true
    },
    yearsExperience: {
        type: String,
        required: true
    },
    relevantExperience: {
        type: String,
        required: true
    },
    skill: {
        type: String,
        required: true
    },
    role:{
        type:String,
    },
    requirementtype:{
      type:String,
      required:true
    },
    // assessments: [AssessmentSchema]
    assessments: [
        {
            assessment: {
                type: String,
                required: true
            },
            yoe: {
                type: String,
                required: true
            }
        }
    ],
    uploadedBy:{
        type:String,
    },
    clientId:{
        type:String,
    },
    update:{
        type:String,
        default:"New"
    },
    uploadedDate: {
        type: Date,
        default: Date.now
    },
    claimedBy: [{ userId: String, claimedDate: Date }]   
});

let NewRequirment = new mongoose.model("Requirements",RequirementSchema);

app.post("/newRequirment",upload.none(),async(req,res)=>{ 
    // let RegID=await NewRequirment.find().and({reqId:req.body.reqId});
    // if (RegID.length>0) {
    //     res.json({status:"failure",msg:"Reg ID already Exist❌"});
    // }else{
    try{
          const{
            assessments
          } = req.body;
        // Ensure assessments is an array of objects
const formattedAssessments = Array.isArray(assessments) ? assessments.map(item => ({
    assessment: item.assessment || "",
    yoe: item.yoe || ""
  })) : [];

        let newRequirment = new NewRequirment({
          regId:req.body.regId,
          client:req.body.client,
          typeOfContract:req.body.typeOfContract,
          startDate:req.body.startDate,
          duration:req.body.duration,
          location:req.body.location,
          sourceCtc:req.body.sourceCtc,
          qualification:req.body.qualification,
          yearsExperience:req.body.yearsExperience,
          relevantExperience:req.body.relevantExperience,
          skill:req.body.skill,
          role:req.body.role,
          requirementtype:req.body.requirmentType,
          update:req.body.update,
          uploadedBy:req.body.uploadedBy,
          clientId:req.body.clientId,
        assessments:formattedAssessments
        });
        await newRequirment.save();
        console.log(req.body);
        res.json({status:"Success",msg:" Requirment Added Successfully✅"});
    }catch(error){
        res.json({status:"Failed",error:error,msg:"Invalid Details ❌"});
        console.log(error);       
    }
    }
);

app.get('/getrequirements', async (req, res) => {
    try {
      const requirements = await NewRequirment.find();
      res.json(requirements);
    } catch (err) {
      res.json({ status: "Error", msg: err.message });
    }
  });

  app.get('/getTeamrequirements/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        // Step 1: Find the user by userId
        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: "Error", msg: "User not found" });
        }

        // Step 2: Get the client's IDs and the user's Requirements array
        const clientIds = user.Clients; // Assuming Clients field contains an array of client IDs
        const userRequirementsIds = user.Requirements; // Get the user's assigned Requirements array

        // Step 3: Fetch the requirements that match the client IDs from the NewRequirement schema
        const clientRequirements = await NewRequirment.find({ clientId: { $in: clientIds } });

        // Fetch the user's requirements from the NewRequirement schema using the Requirements array
        const userRequirements = await NewRequirment.find({ _id: { $in: userRequirementsIds } });

        // Combine both client-related and user-related requirements
        const allRequirements = [...clientRequirements, ...userRequirements];

        if (allRequirements.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No requirements found for the associated clients or user" });
        }

        // Step 4: Get the user's Team (team members' IDs)
        const teamIds = user.Team;

        if (!teamIds || teamIds.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No team members associated with this user" });
        }

        // Step 5: Find the team members from the NewUser schema
        const teamMembers = await NewUser.find({ _id: { $in: teamIds } });

        if (!teamMembers || teamMembers.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No team members found" });
        }

        // Total team member count
        const totalTeamCount = teamMembers.length;

        // Step 6: Loop through each requirement and find how many team members have that requirement in their Requirements array
        const result = [];

        for (const req of allRequirements) {
            const requirementId = req._id;

            // Find the count of team members who have this requirement in their Requirements array
            const assignedCount = await NewUser.countDocuments({
                _id: { $in: teamIds },
                Requirements: requirementId
            });

            // Add the requirement, assigned count, and total team count to the result array
            result.push({
                requirement: req, // Requirement details
                assignedCount: assignedCount, // How many team members have this requirement assigned
                totalTeamCount: totalTeamCount // Total team count
            });
        }

        // Step 7: Return the result (requirements along with the count of team members assigned to each requirement and total team count)
        res.json(result);

    } catch (err) {
        res.status(500).json({ status: "Error", msg: err.message });
    }
});


  
  app.get('/getHomeReqData/:userId', async (req, res) => {
    const { userId } = req.params;
    console.log(userId);

    try {
        // Step 1: Find the user by userId
        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: "Error", msg: "User not found" });
        }

        // Step 2: Get the client's IDs and Requirements associated with the user
        const clientIds = user.Clients; // Assuming Clients field contains an array of client IDs
        const userRequirements = user.Requirements; // Assuming Requirements field contains an array of requirement IDs

        if ((!clientIds || clientIds.length === 0) && (!userRequirements || userRequirements.length === 0)) {
            return res.status(404).json({ status: "Error", msg: "No clients or requirements associated with this user" });
        }

        // Step 3: Fetch the requirements that match the client IDs or the Requirements field in the user schema
        const requirements = await NewRequirment.find({
            $or: [
                { clientId: { $in: clientIds } },           // Match by client IDs
                { _id: { $in: userRequirements } }          // Match by requirement IDs from the user
            ]
        });

        // Step 4: Return the matching requirements
        res.json(requirements);

    } catch (err) {
        res.status(500).json({ status: "Error", msg: err.message });
    }
});
  
app.get('/getrequirements/:id', async (req, res) => {
    const Id = req.params.id;    
    try {
        // Fetch requirement by ID
        const requirement = await NewRequirment.findById(Id);

        // Check if the requirement exists
        if (!requirement) {
            return res.status(404).json({ status: "Error", msg: "Requirement not found" });
        }

        // Return the fetched requirement
        res.status(200).json(requirement);
    } catch (err) {
        // Handle any errors
        console.error(err.message);
        res.status(500).json({ status: "Error", msg: "Server Error" });
    }
});

app.put('/claim/:id', async (req, res) => {
    const { id } = req.params;
    const { userId, claimedDate } = req.body;
  
    if (!userId || !claimedDate) {
      return res.status(400).json({ status: "Fail", msg: "Missing required fields." });
    }
  
    try {
      // Check if the requirement exists
      const requirement = await NewRequirment.findById(id);
      if (!requirement) {
        return res.status(404).json({ status: "Fail", msg: "Requirement not found." });
      }
  
      // Add user to the claimedBy array
      const result = await NewRequirment.findByIdAndUpdate(
        id,
        {
          $addToSet: {
            claimedBy: {
              userId: userId,
              claimedDate: new Date(claimedDate),
            }
          }
        },
        { new: true }
      );
  
      if (result) {
        res.json({ status: "Success", msg: "Requirement claimed successfully." });
      } else {
        res.status(500).json({ status: "Fail", msg: "Failed to update requirement." });
      }
    } catch (err) {
      console.error('Server error:', err);
      res.status(500).json({ status: "Fail", msg: "Server error." });
    }
  });
   
app.get("/actions/:id/:userid", async (req, res) => {
    try {
        // Extract the requirement ID and user ID from the request parameters
        const requirementId = req.params.id;
        const userId = req.params.userid;
        
        if (!userId) {
            return res.status(401).json({ status: 'Failed', msg: 'User not authenticated' });
        }

        // Fetch the user to check their UserType
        const user = await NewUser.findById(userId);
        
        if (!user) {
            return res.status(404).json({ status: 'Failed', msg: 'User not found' });
        }

        // Find the requirement by ID
        const requirement = await NewRequirment.findById(requirementId);
        
        if (!requirement) {
            return res.status(404).json({ status: 'Failed', msg: 'Requirement not found' });
        }

        // Check if the user is either a TeamLead or has claimed the requirement
        const userClaim = requirement.claimedBy.find(claim => claim.userId === userId);

        if (!userClaim && user.UserType !== 'TeamLead') {
            return res.status(403).json({ status: 'Failed', msg: 'You do not have access to this requirement' });
        }

        // Send the requirement data as response
        res.json(requirement);
    } catch (error) {
        console.error('Error fetching requirement:', error);
        res.status(500).json({ status: 'Failed', msg: 'Internal server error', error: error.message });
    }
});

const AssessmentSchema = new mongoose.Schema({
    assessment: {
        type: String,
        required: true
    },
    yoe: {
        type: String,
        required: true
    },
    score: {
        type: String,
        // required:true
    }
});
// Define the schema for Candidates
const CandidateSchema = new mongoose.Schema({
    date: {
        type: Date,
        default: Date.now // Automatically set to current date
    },
    firstName: {
        type: String,
        required: true
    },
    lastName: {
        type: String,
        required: true
    },
    dob: {
        type: Date,
        required: true
    },
    mobileNumber: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    ctc: {
        type: String,
        required: true
    },
    ectc: {
        type: String,
        required: true
    },
    totalYoe: {
        type: String,
        required: true
    },
    relevantYoe: {
        type: String,
        required: true
    },
    lwd: {
        type: Date
    },
    currentLocation: {
        type: String,
        required: true
    },
    prefLocation: {
        type: String,
        required: true
    },
    resignationServed: {
        type: String,
        enum: ['Yes', 'No'],
        required: true
    },
    currentOrg: {
        type: String,
        required: true
    },
    candidateSkills: {
        type: String,
        required: true
    },
    role: {
        type: String,
        required: true
    },
    Status: [
        {
            Status: {
                type: String,
                required: true
            },
            Date: {
                type: Date,
                default: Date.now
            } 
        }
    ],
    savedStatus: {
        type: String,
        enum: ['Saved', 'Uploaded'],
        // required: true
    },
    feedback: {
        type: String
    },
    details: {
        type: String
    },
    interviewDate: {
        type: Date
    },
    educationalQualification: {
        type: String,
        required: true
    },
    offerInHand: {
        type: String
    },
    remark: {
        type: String
    },
    updatedResume: {
        type: String,// Path to the uploaded resume file
        // required:true
    },
    ornnovaProfile: {
        type: String, // Path to the uploaded Ornnova profile file
        // required:true

    },
    candidateImage: {
        type: String, // Path to the uploaded image file
        // required:true
    },
    assessments: [AssessmentSchema] ,
    uploadedOn: {
        type: Date,
        default: Date.now
    },
    recruiterId: [{
        type: String,
        required: true
    }]
});
// Define the main schema that includes reqId, recruiterId, candidates, and assessments
const MainSchema = new mongoose.Schema({
    reqId: {
        type: String,
        required: true
    },
    recruiterId: [{
        type: String,
        required: true
    }],
    candidates: [CandidateSchema],
   
});

const CandidateModel = mongoose.model('Candidate', MainSchema); // Or the correct model name

const uploadFields = upload.fields([
    { name: 'updatedResume', maxCount: 1 },
    { name: 'ornnovaProfile', maxCount: 1 },
    { name: 'candidateImage', maxCount: 1 }
]);

app.post('/Candidates', uploadFields, async (req, res) => {
    try {
        const { reqId, recruiterId, candidate } = req.body;
       console.log(req.body);
        // Log candidate data for debugging
        // console.log('Received candidate string:', candidate);

        // Check if candidate is provided
        if (!candidate) {
            throw new Error('Candidate data is missing or invalid');
        }

        // Parse candidate data
        let candidateData;
        try {
            candidateData = JSON.parse(candidate);
        } catch (parseError) {
            throw new Error('Failed to parse candidate data: ' + parseError.message);
        }

        // Attach file paths if they exist
        if (req.files['updatedResume']) candidateData.updatedResume = req.files['updatedResume'][0].path;
        if (req.files['ornnovaProfile']) candidateData.ornnovaProfile = req.files['ornnovaProfile'][0].path;
        if (req.files['candidateImage']) candidateData.candidateImage = req.files['candidateImage'][0].path;

        // Check if a record with the same reqId and recruiterId exists
        let existingCandidate = await CandidateModel.findOne({ reqId, recruiterId });

        if (existingCandidate) {
            // Add the new candidate to the existing candidates array
            existingCandidate.candidates.push(candidateData);
            await existingCandidate.save();
        } else {
            // Create a new document with the candidate details
            const newCandidate = new CandidateModel({ reqId, recruiterId, candidates: [candidateData] });
            await newCandidate.save();
        }

        res.status(200).json({ message: 'Candidate data saved successfully' });
    } catch (error) {
        console.error('Error saving candidate data:', error);
        res.status(500).json({ message: 'Failed to save candidate data' });
    }
});

app.get('/viewactions/:id/:userid', async (req, res) => {
    const { id, userid } = req.params;

    // Check if both id and userid are provided
    if (!id || !userid) {
        return res.status(400).json({ error: 'ID and UserID are required' });
    }

    try {
        // Find the document based on the reqId (id in this case) and recruiterId (userid)
        const requirement = await CandidateModel.findOne({ reqId: id, recruiterId: userid }).exec();

        // Check if the document is found and contains candidates
        if (requirement && requirement.candidates.length > 0) {
            const candidates = requirement.candidates;

            // Separate candidates based on savedStatus
            const savedCandidates = candidates.filter(candidate => candidate.savedStatus === 'Saved');
            const uploadedCandidates = candidates.filter(candidate => candidate.savedStatus === 'Uploaded');

            // Return separate counts and details for each status
            res.json({
                candidateCount: candidates.length,
                savedCount: savedCandidates.length,
                uploadedCount: uploadedCandidates.length,
                savedCandidates,     // Details of candidates with savedStatus: "Saved"
                uploadedCandidates ,  // Details of candidates with savedStatus: "Uploaded"
                candidates
            });
        } else {
            res.json({ message: 'No candidates found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch candidates' });
    }
});

app.delete('/api/candidates/:id', async (req, res) => {
    try {
        const candidateId = req.params.id;

        // Find the document that contains the candidate to be deleted
        const updatedDocument = await CandidateModel.findOneAndUpdate(
            { "candidates._id": candidateId }, // Find the document containing the candidate
            { $pull: { candidates: { _id: candidateId } } }, // Remove the candidate from the array
            { new: true } // Return the updated document
        );

        if (updatedDocument) {
            res.status(200).json({ message: 'Candidate deleted successfully ✅' });
        } else {
            res.status(404).json({ message: 'Candidate not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error deleting candidate', error });
        console.log(error);
    }
});
// To get Cndidates Count For a Particular Requirments
app.get('/adminviewactions/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ error: 'ID is required' });
    }

    try {
        // Find all documents with the given reqId
        const requirements = await CandidateModel.find({ reqId: id }).exec();

        if (requirements.length > 0) {
            // Aggregate only candidates with savedStatus "Uploaded"
            const allCandidates = requirements.flatMap(req => 
                req.candidates.filter(candidate => candidate.savedStatus === 'Uploaded')
            );
            const candidateCount = allCandidates.length;
            res.json({ candidateCount, candidates: allCandidates });
        } else {
            res.status(404).json({ message: 'No requirement found for the given ID' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch candidates', details: error });
    }
});
// To get Claimed Count
app.get('/api/requirements/:id/claimedByCount', async (req, res) => {
    try {
        const requirementId = req.params.id;
        const requirement = await NewRequirment.findById(requirementId);
             
        if (!requirement) {
            return res.status(404).json({ message: 'Requirement not found' });
        }

        const claimedByCount = requirement.claimedBy.length;

        res.status(200).json({ claimedByCount });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error });
        console.log(error)
    }
});
// To get Claimed users Data
app.get('/api/requirements/:id/claimedByDetails', async (req, res) => {
    try {
        const requirementId = req.params.id;
        const requirement = await NewRequirment.findById(requirementId);
        
        if (!requirement) {
            return res.status(404).json({ message: 'Requirement not found' });
        }

        // Extract user IDs from the claimedBy array
        const userIds = requirement.claimedBy.map(claim => claim.userId);

        // Find the user details for each userId
        const claimedUsers = await NewUser.find({ _id: { $in: userIds } });

        res.status(200).json({ claimedUsers });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error });
        console.log(error);
    }
});
// Get the number of candidates added by each recruiter for a specific reqId
app.get('/api/recruiters/:reqId', async (req, res) => {
    const { reqId } = req.params;

    if (!reqId) {
        return res.status(400).json({ error: 'reqId is required' });
    }

    try {
        // Fetch requirements based on reqId
        const requirements = await CandidateModel.find({ reqId }).exec();

        if (requirements.length === 0) {
            return res.status(404).json({ message: 'Requirement(s) not found' });
        }

        const recruiterIdToCandidateCount = {};
        const recruiterIdToCandidates = {}; // Object to map recruiterId to candidate details

        // Iterate through each requirement and its candidates
        requirements.forEach(requirement => {
            requirement.candidates
                .filter(candidate => candidate.savedStatus === 'Uploaded') // Filter candidates by savedStatus
                .forEach(candidate => {
                    candidate.recruiterId.forEach(recruiterId => {
                        // Count only "Uploaded" candidates for each recruiter
                        recruiterIdToCandidateCount[recruiterId] = (recruiterIdToCandidateCount[recruiterId] || 0) + 1;

                        // Add only "Uploaded" candidate details to the recruiter
                        if (!recruiterIdToCandidates[recruiterId]) {
                            recruiterIdToCandidates[recruiterId] = []; // Initialize array for the first time
                        }
                        recruiterIdToCandidates[recruiterId].push(candidate);
                    });
                });
        });

        const recruiterIds = Object.keys(recruiterIdToCandidateCount);

        if (recruiterIds.length === 0) {
            return res.status(404).json({ message: 'No recruiters found for these requirements' });
        }

        // Fetch recruiter details from NewUser collection
        const recruitersDetails = await NewUser.find({ _id: { $in: recruiterIds } }).exec();

        if (recruitersDetails.length === 0) {
            return res.status(404).json({ message: 'No details found for recruiters' });
        }

        // Create the response with recruiter info and associated "Uploaded" candidate details
        const recruitersWithCandidateCountAndDetails = recruitersDetails.map(recruiter => ({
            recruiter,
            candidateCount: recruiterIdToCandidateCount[recruiter._id.toString()],
            candidates: recruiterIdToCandidates[recruiter._id.toString()] || [], // Include only "Uploaded" candidate details
            reqId // Include the reqId in the response
        }));

        res.status(200).json({ recruiters: recruitersWithCandidateCountAndDetails });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error });
        console.error('Server Error:', error);
    }
});

// Define a route to get candidates by recruiter ID
app.get('/api/candidates', async (req, res) => {
    try {
        const { recruiterId, reqId } = req.query;
        console.log('Fetching candidates with:', { recruiterId, reqId });

        if (!recruiterId || !reqId) {
            return res.status(400).json({ message: 'Recruiter ID and Requirement ID are required' });
        }

        // Find candidates by recruiterId and reqId
        const candidatesData = await CandidateModel.find({
            recruiterId: recruiterId,
            reqId: reqId
        }).select('candidates -_id'); // Select only the candidates field and exclude _id

        // Extract only the candidates array from the result
        const candidates = candidatesData.map(doc => doc.candidates).flat();

        // Respond with the candidates data
        res.json(candidates);
    } catch (error) {
        console.error('Error fetching candidates:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});
// Get a specific candidate by ID
app.get('/candidate/:id', async (req, res) => {
    const candidateId = req.params.id;

    try {
        const mainEntry = await CandidateModel.findOne({
            'candidates._id': candidateId
        });

        if (!mainEntry) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Find the candidate within the Main document
        const candidate = mainEntry.candidates.id(candidateId);

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Send the candidate data as a response
        res.json(candidate);
    } catch (err) {
        console.error('Error fetching candidate:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});
// Update candidate details
app.put('/candidates/:id', async (req, res) => {
    const candidateId = req.params.id;
    const updateData = req.body;

    try {
        // Find the candidate in the nested structure of MainSchema
        const mainDoc = await CandidateModel.findOne({ "candidates._id": candidateId });

        if (!mainDoc) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Find the index of the candidate in the candidates array
        const candidateIndex = mainDoc.candidates.findIndex(candidate => candidate._id.toString() === candidateId);

        if (candidateIndex === -1) {
            return res.status(404).json({ message: 'Candidate not found in the array' });
        }

        // Update the candidate details
        mainDoc.candidates[candidateIndex] = { ...mainDoc.candidates[candidateIndex]._doc, ...updateData };

        // Save the updated MainSchema document
        await mainDoc.save();

        res.status(200).json(mainDoc.candidates[candidateIndex]);
    } catch (error) {
        console.error('Error updating candidate:', error);
        res.status(500).json({ message: 'Server error' });
    }
});
// Assig Client to User
app.post('/assignClient/:userId/:clientId', async (req, res) => {
    const { userId,clientId} = req.params;
    // Ensure clientId is in the correct format
    if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Client ID format.' });
    }

    if (!clientId) {
        return res.status(400).json({ status: 'error', msg: 'Client ID is required.' });
    }

    try {
        // Validate userId format
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ status: 'error', msg: 'Invalid User ID format.' });
        }

        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: 'error', msg: 'User not found.' });
        }

        // Check if clientId is already in the Clients array
        if (!user.Clients.includes(clientId)) {
            user.Clients.push(clientId);
            await user.save();
            res.json({ status: 'success', msg: 'Client assigned successfully ✅' });
        } else {
            res.json({ status: 'error', msg: 'Client already assigned to this user 😊' });
        }
    } catch (error) {
        console.error('Error assigning client:', error);
        res.status(500).json({ status: 'error', msg: 'An error occurred while assigning the client.' });
    }
});
// Unassign Client from User
app.post('/unassignClient/:userId/:clientId', async (req, res) => {
    const { userId, clientId } = req.params;

    // Ensure clientId is in the correct format
    if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Client ID format.' });
    }

    if (!clientId) {
        return res.status(400).json({ status: 'error', msg: 'Client ID is required.' });
    }

    try {
        // Validate userId format
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ status: 'error', msg: 'Invalid User ID format.' });
        }

        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: 'error', msg: 'User not found.' });
        }

        // Check if clientId is in the Clients array
        const clientIndex = user.Clients.indexOf(clientId);
        if (clientIndex !== -1) {
            // Remove clientId from the Clients array
            user.Clients.splice(clientIndex, 1);
            await user.save();
            res.json({ status: 'success', msg: 'Client unassigned successfully ✅' });
        } else {
            res.json({ status: 'error', msg: 'Client not assigned to this user 😊' });
        }
    } catch (error) {
        console.error('Error unassigning client:', error);
        res.status(500).json({ status: 'error', msg: 'An error occurred while unassigning the client.' });
    }
});

// Get TL Home Details
app.get('/TlHome/:id', async (req, res) => {
    try {
        const id = req.params.id;

        // Find the user by ID
        const userData = await NewUser.findById(id);

        if (!userData) {
            return res.status(404).json({ message: "User not found" });
        }

        // Fetch the client data using the IDs from the Team array
        const TeamData = await NewUser.find({
            _id: { $in: userData.Team }
        });

        // Respond with the user data and associated client data
        res.json({
            user: userData,
            Team: TeamData
        });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Server Error", error: err });
    }
});
// Get Team Client Details
app.get('/TlClients/:id', async (req, res) => {
    try {
        const id = req.params.id;

        // Find the user by ID
        const userData = await NewUser.findById(id);

        if (!userData) {
            return res.status(404).json({ message: "User not found" });
        }

        // Fetch the client data using the IDs from the Team array
        const ClientData = await NewClient.find({
            _id: { $in: userData.Clients }
        });

        // Respond with the user data and associated client data
        res.json({
            user: userData,
            Client: ClientData
        });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Server Error", error: err });
    }
});
// Assign Requirement to User
app.post('/assignReq/:userId/:requirementId', async (req, res) => {
    const { userId, requirementId } = req.params;

    // Ensure requirementId is in the correct format
    if (!mongoose.Types.ObjectId.isValid(requirementId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Requirement ID format.' });
    }

    if (!requirementId) {
        return res.status(400).json({ status: 'error', msg: 'Requirement ID is required.' });
    }

    try {
        // Validate userId format
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ status: 'error', msg: 'Invalid User ID format.' });
        }

        // Find the user by userId
        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: 'error', msg: 'User not found.' });
        }

        // Check if requirementId is already in the Requirements array
        if (!user.Requirements.includes(requirementId)) {
            // Push the new requirementId into the Requirements array
            user.Requirements.push(requirementId);
            await user.save();  // Save the updated user document

            res.json({ status: 'success', msg: 'Requirement assigned successfully ✅' });
        } else {
            res.json({ status: 'error', msg: 'Requirement already assigned to this user 😊' });
        }
    } catch (error) {
        console.error('Error assigning requirement:', error);
        res.status(500).json({ status: 'error', msg: 'An error occurred while assigning the requirement.' });
    }
});

// Unassign Requirement from User
app.post('/unassignReq/:userId/:requirementId', async (req, res) => {
    const { userId, requirementId } = req.params;

    // Ensure requirementId is in the correct format
    if (!mongoose.Types.ObjectId.isValid(requirementId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Requirement ID format.' });
    }

    if (!requirementId) {
        return res.status(400).json({ status: 'error', msg: 'Requirement ID is required.' });
    }

    try {
        // Validate userId format
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ status: 'error', msg: 'Invalid User ID format.' });
        }

        // Find the user by userId
        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: 'error', msg: 'User not found.' });
        }

        // Check if requirementId is in the Requirements array
        if (user.Requirements.includes(requirementId)) {
            // Remove the requirementId from the Requirements array
            user.Requirements = user.Requirements.filter(reqId => reqId.toString() !== requirementId);
            await user.save();  // Save the updated user document

            res.json({ status: 'success', msg: 'Requirement unassigned successfully ✅' });
        } else {
            res.json({ status: 'error', msg: 'Requirement not found for this user 😊' });
        }
    } catch (error) {
        console.error('Error unassigning requirement:', error);
        res.status(500).json({ status: 'error', msg: 'An error occurred while unassigning the requirement.' });
    }
});


// Get Total Count of the candidates
app.get('/getTeamRequirementsCount/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        // Step 1: Find the user by userId
        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: "Error", msg: "User not found" });
        }

        // Step 2: Get the team members' IDs associated with the user
        const teamMemberIds = user.Team;

        if (!teamMemberIds || teamMemberIds.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No team members associated with this user" });
        }

        // Step 3: Fetch all requirements from MainSchema that match any team member's recruiterId
        const teamRequirements = await CandidateModel.find({
            recruiterId: { $in: teamMemberIds }
        });

        if (teamRequirements.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No requirements found for team members" });
        }

        // Step 4: Initialize total candidates count, today's candidates count, and arrays to hold data
        let totalCandidatesCount = 0;
        let todaysCandidatesCount = 0;
        let totalCandidatesData = [];
        let todaysCandidatesData = [];
        let recruiterStats = []; // Array to hold stats for each recruiter

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set time to midnight for today's comparison

        // Step 5: Iterate through each team member (recruiter)
        for (const recruiterId of teamMemberIds) {
            let recruiterTotalCandidates = 0;
            let recruiterTodaysCandidates = 0;
            let recruiterCandidatesData = [];
            let recruiterTodaysData = [];

            // Fetch recruiter details from NewUser schema
            const recruiterDetails = await NewUser.findById(recruiterId);

            if (!recruiterDetails) {
                continue; // If recruiter not found, skip this recruiter
            }

            // Filter requirements for the current recruiter
            const recruiterRequirements = teamRequirements.filter(req => req.recruiterId.includes(recruiterId));

            // Process each requirement for the recruiter
            recruiterRequirements.forEach(req => {
                req.candidates.forEach(candidate => {
                    // Only include candidates with savedStatus as "Uploaded"
                    if (candidate.savedStatus === "Uploaded") {
                        recruiterTotalCandidates++; // Increment recruiter's total candidates count
                        totalCandidatesCount++; // Increment total for all recruiters
                        recruiterCandidatesData.push(candidate); // Collect recruiter's candidate data
                        totalCandidatesData.push(candidate); // Collect all candidate data

                        // Check if candidate was uploaded today
                        const uploadedOn = new Date(candidate.uploadedOn);
                        if (uploadedOn >= today) {
                            recruiterTodaysCandidates++; // Increment recruiter's today's candidates count
                            todaysCandidatesCount++; // Increment today's total count
                            recruiterTodaysData.push(candidate); // Collect recruiter's today's data
                            todaysCandidatesData.push(candidate); // Collect today's total data
                        }
                    }
                });
            });

            // Add this recruiter's stats to the recruiterStats array
            recruiterStats.push({
                recruiterId: recruiterDetails._id,
                recruiterCode: recruiterDetails.EmpCode,
                recruiterName: recruiterDetails.EmployeeName, // Add recruiter name
                recruiterEmail: recruiterDetails.Email,       // Add recruiter email
                totalCandidates: recruiterTotalCandidates,
                todaysCandidates: recruiterTodaysCandidates,
                totalCandidatesData: recruiterCandidatesData,  // Candidate data for this recruiter
                todaysCandidatesData: recruiterTodaysData      // Today's candidate data for this recruiter
            });
        }

        // Step 6: Send the response with total, today's counts, candidate data, and recruiter stats
        res.json({
            status: "Success",
            totalCandidates: totalCandidatesCount,
            todaysCandidates: todaysCandidatesCount,
            totalCandidatesData,       // Array of all candidates
            todaysCandidatesData,      // Array of today's candidates
            recruiterStats             // Array with stats for each recruiter, including their details
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ status: "Error", msg: err.message });
    }
});


app.get('/getRequirementsCandidatesCount/:recruiterId', async (req, res) => {
    const { recruiterId } = req.params;

    try {
        // Step 1: Fetch all requirements related to the recruiter
        const recruiterRequirements = await CandidateModel.find({
            recruiterId: recruiterId
        });

        if (recruiterRequirements.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No requirements found for this recruiter" });
        }

        // Step 2: Collect reqIds from the recruiterRequirements
        const reqIds = recruiterRequirements.map(req => req.reqId);

        // Step 3: Fetch requirement details using reqIds
        const requirements = await NewRequirment.find({
            _id: { $in: reqIds } // Convert string ids to ObjectId
        });

        // Step 4: Create a map to store candidate counts for each reqId
        const reqIdToCandidateCount = {};

        // Populate the candidate counts, only counting candidates with savedStatus as "Uploaded"
        recruiterRequirements.forEach(req => {
            const uploadedCandidatesCount = req.candidates.filter(candidate => candidate.savedStatus === "Uploaded").length;
            if (reqIdToCandidateCount[req.reqId]) {
                reqIdToCandidateCount[req.reqId] += uploadedCandidatesCount;
            } else {
                reqIdToCandidateCount[req.reqId] = uploadedCandidatesCount;
            }
        });

        // Step 5: Attach candidate counts to the requirement details
        const requirementsWithCounts = requirements.map(req => ({
            ...req.toObject(),
            candidateCount: reqIdToCandidateCount[req._id.toString()] || 0
        }));

        // Step 6: Send the response with the requirements and candidate counts
        res.json({
            status: "Success",
            requirements: requirementsWithCounts
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: "Error", msg: err.message });
    }
});

app.get('/requirementDetailsWithAssignedUsers/:userId', async (req, res) => {
    const userId = req.params.userId;

    try {
        // Step 1: Find the user
        const user = await NewUser.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const teamIds = user.Team; // Get the user's team members
        const userClients = user.Clients; // Get the user's associated clients
        const userRequirementsIds = user.Requirements; // Get the user's assigned requirements

        // Step 2: Get team members' details
        const teamUsers = await NewUser.find({ _id: { $in: teamIds } });

        // Step 3: Get all client-related requirements
        const clientRequirements = await NewRequirment.find({
            clientId: { $in: userClients }
        });

        // Step 4: Get user's assigned requirements
        const userRequirements = await NewRequirment.find({
            _id: { $in: userRequirementsIds }
        });

        const allRequirements = [...clientRequirements, ...userRequirements]; // Combine all requirements

        // Get today's date in UTC
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0); // Start of today
        const tomorrow = new Date(today);
        tomorrow.setUTCDate(today.getUTCDate() + 1); // Start of the next day

        // Step 5: Gather requirement details
        const requirementDetailsWithUsernames = await Promise.all(
            allRequirements.map(async (requirement) => {
                const requirementId = requirement._id;

                // Get users assigned to this requirement from team
                const assignedUsersForThisRequirement = teamUsers.filter(teamUser =>
                    teamUser.Requirements.includes(requirementId)
                );

                const usernamesForThisRequirement = assignedUsersForThisRequirement.map(user => user.EmployeeName);
                const userCountForThisRequirement = assignedUsersForThisRequirement.length;

                // Step 6: Get candidate details
                const requirementWithCandidates = await CandidateModel.find({
                    reqId: requirementId,  // Check if reqId matches
                    recruiterId: { 
                        $in: [...teamIds, userId]  // Spread teamIds and add userId to the $in array
                    }
                }).select('candidates reqId recruiterId');           

                // Separate candidates based on recruiterId (user vs team) and apply savedStatus filter
                const userCandidates = requirementWithCandidates ? requirementWithCandidates.flatMap(req => 
                    req.candidates.filter(candidate => 
                        req.recruiterId.toString() === userId
                    )
                ) : [];

                const teamCandidates = requirementWithCandidates ? requirementWithCandidates.flatMap(req => 
                    req.candidates.filter(candidate => 
                        teamIds.includes(req.recruiterId.toString()) && candidate.savedStatus === 'Uploaded'
                    )
                ) : [];

                // Total candidate count
                const totalCandidateCount = userCandidates.length + teamCandidates.length;

                // Filter for today's candidates for both user and team
                const todayUserCandidates = userCandidates.filter(candidate => {
                    const uploadedOnDate = new Date(candidate.uploadedOn);
                    return uploadedOnDate >= today && uploadedOnDate < tomorrow;
                });

                const todayTeamCandidates = teamCandidates.filter(candidate => {
                    const uploadedOnDate = new Date(candidate.uploadedOn);
                    return uploadedOnDate >= today && uploadedOnDate < tomorrow;
                });

                const todayCandidateCount = todayUserCandidates.length + todayTeamCandidates.length;

                // Step 7: Combine user and team candidates into totalCandidatesDetails
                const totalCandidatesDetails = [...userCandidates, ...teamCandidates];

                // Combine today's user and team candidates
                const combinedTodayCandidates = [...todayUserCandidates, ...todayTeamCandidates];

                // Step 9: Return the details
                return {
                    requirementDetails: requirement,
                    userCount: userCountForThisRequirement,
                    assignedUsernames: usernamesForThisRequirement,
                    totalCandidateCount: totalCandidateCount,
                    todayCandidateCount: todayCandidateCount,
                    userCandidatesCount: userCandidates.length,
                    teamCandidatesCount: teamCandidates.length, // Only "Uploaded" team candidates are counted here
                    todayUserCandidates: todayUserCandidates,
                    todayTeamCandidates: todayTeamCandidates, // Only "Uploaded" team candidates for today
                    totalUserCandidatesDetails: userCandidates,
                    totalTeamCandidatesDetails: teamCandidates, // Only "Uploaded" team candidates
                    totalCandidatesDetails: totalCandidatesDetails, // All candidates (user + team)
                    combinedTodayCandidates: combinedTodayCandidates // Combined today candidates (user + team)
                };
            })
        );

        res.json(requirementDetailsWithUsernames);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server Error", error });
    }
});



app.delete('/deleteRequirement/:regId', async (req, res) => {
    const regId = req.params.regId; // Get the regId from the request parameters

    try {
        // Step 1: Find and delete the requirement by regId
        const deletedRequirement = await NewRequirment.findOneAndDelete({ _id: regId });

        if (!deletedRequirement) {
            return res.status(404).json({ message: "Requirement not found" });
        }

        // Step 2: Find and delete the candidates assigned to this requirement
        const deletedCandidates = await CandidateModel.deleteMany({ reqId: regId });

        // Step 3: Return success message with details
        res.status(200).json({
            message: "Requirement and associated candidates deleted successfully",
            deletedRequirement,
            deletedCandidates: deletedCandidates.deletedCount // Number of deleted candidates
        });
    } catch (error) {
        console.error("Error deleting requirement and candidates:", error);
        res.status(500).json({ message: "Server error", error });
    }
});

// PUT endpoint to update a requirement
app.put('/editRequirement/:id', async (req, res) => {
    const { id } = req.params; // Extract the requirement ID from the URL
    const updateData = req.body; // Get the data to update from the request body
    console.log(id)
    try {
        // Find the requirement by ID and update it
        const updatedRequirement = await NewRequirment.findByIdAndUpdate(id, updateData, {
            new: true, // Return the updated document
            runValidators: true // Run schema validation
        });

        // Check if requirement was found and updated
        if (!updatedRequirement) {
            return res.status(404).json({ message: 'Requirement not found' });
        }

        // Respond with the updated requirement
        res.status(200).json(updatedRequirement);
    } catch (error) {
        console.error('Error updating requirement:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// Update candidate status using only the candidate ID
app.put('/updatestatus/:candidateId', async (req, res) => {
    const candidateId = req.params.candidateId;
    const { status } = req.body;

    console.log('Request body:', req.body); // Log request body to debug

    if (!status) {
        return res.status(400).json({ message: 'Status is required' });
    }

    try {
        const updatedMain = await CandidateModel.findOneAndUpdate(
            { 'candidates._id': candidateId },
            {
                $push: {
                    'candidates.$.Status': {
                        Status: status,
                        Date: new Date()
                    }
                }
            },
            { new: true }
        );

        if (!updatedMain) {
            return res.status(404).json({ message: 'Candidate not found in any main document' });
        }

        res.status(200).json({ message: 'Status updated successfully ✅', mainDocument: updatedMain });
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// Requirments in Admin 
app.get('/admingetrequirements', async (req, res) => {
    try {
        // Fetch all requirements
        const requirements = await NewRequirment.find();

        // Initialize an array to hold the final response
        const enrichedRequirements = [];

        // Loop through each requirement
        for (const requirement of requirements) {
            // Extract clientId and reqId from the requirement
            const clientId = requirement.clientId;
            const reqId = requirement._id; // Assuming this is the reqId

            // Find users associated with this clientId in their Clients array or reqId in Requirements array
            const users = await NewUser.find({
                $or: [
                    { Clients: clientId },
                    { Requirements: reqId }
                ]
            });

            // Get the user count
            const userCount = users.length;
            // Add the requirement along with user data to the enriched requirements array
            enrichedRequirements.push({
                ...requirement._doc, // Spread the requirement fields
                userCount, // Add the user count
                userDetails: users // Add the user details if needed
            });
        }

        // Send the enriched requirements data as response
        res.json(enrichedRequirements);
    } catch (err) {
        res.status(500).json({ status: "Error", msg: err.message });
    }
});

// Users Data of Requirment
app.get('/admingetrequirements/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch the specific requirement by ID
        const requirement = await NewRequirment.findById(id);

        if (!requirement) {
            return res.status(404).json({ status: "Error", msg: "Requirement not found" });
        }

        // Get the clientId from the requirement
        const clientId = requirement.clientId;
        const reqId = requirement._id; // Assuming this is the reqId

        // Find users associated with the clientId or reqId, and with UserType 'User' or 'TeamLead'
        const users = await NewUser.find({
            UserType: { $in: ['User', 'TeamLead'] }, // Filter for UserType first
            $or: [
                { Clients: clientId },   // Clients matching clientId
                { Requirements: reqId }   // Requirements matching reqId
            ]
        });

        // Map user details for the filtered users
        const userDetails = users.map(user => ({
            _id: user._id,
            name: user.EmployeeName,
            email: user.Email,
            userType: user.UserType
        }));

        // Create an enriched response with requirement details and user data
        const enrichedRequirement = {
            ...requirement._doc, // Spread the requirement details
            userDetails // Add the filtered user details
        };

        // Send the enriched requirement data as a response
        res.json(enrichedRequirement);
    } catch (err) {
        console.error('Server error:', err.message); // Log the error for debugging
        res.status(500).json({ status: "Error", msg: err.message });
    }
});

app.get('/remainingusers/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch the specific requirement by ID
        const requirement = await NewRequirment.findById(id);

        if (!requirement) {
            return res.status(404).json({ status: "Error", msg: "Requirement not found" });
        }

        // Get the clientId and reqId from the requirement
        const clientId = requirement.clientId;
        const reqId = requirement._id; // Assuming this is the reqId

        // Find users who do NOT have this clientId in their Clients array and Requirements
        const remainingUsers = await NewUser.find({
            Clients: { $ne: clientId }, // Exclude users associated with this clientId
            Requirements: { $ne: reqId }, // Exclude users associated with this reqId
            UserType: { $in: ['User', 'TeamLead'] } // Filter for UserType 'User' and 'TeamLead'
        });

        // Map user details for the filtered remaining users
        const remainingUserDetails = remainingUsers.map(user => ({
            _id: user._id,
            name: user.EmployeeName,
            email: user.Email,
            userType: user.UserType
        }));

        // Send the remaining user data as a response
        res.json(remainingUserDetails);
    } catch (err) {
        console.error('Server error:', err.message); // Log the error for debugging
        res.status(500).json({ status: "Error", msg: err.message });
    }
});




  














  


  






