const path = require('path');
const mongoose = require('mongoose');
const NewUser = require('../models/User');
const NewClient = require('../models/Client');
const NewRequirment = require('../models/Requirement');
const CandidateModel = require('../models/Candidate');
const asyncHandler = require('../middleware/asyncHandler');
const { validateObjectId, isValidObjectId } = require('../middleware/validateObjectId');
const { upload, uploadFields } = require('../config/multer');
const { sendEmailSafely } = require('../config/mail');
const { getAdminAnalytics, computeRequirementFunnel, flattenUploadedCandidates } = require('../services/adminAnalytics.service');
const { checkDuplicateCandidate } = require('../services/candidateDuplicate.service');
const {
  getTodayMonitorForUser,
  getUpcomingInterviewsForUser,
  getNotificationsForUser,
} = require('../services/workflow.service');
const {
  getTrackingSummary,
  getStageCandidates,
} = require('../services/trackingDashboard.service');
const {
  getRequirementsForTeamLead,
  getRequirementsForUser,
  userCanAccessRequirement,
  attachRequirementToTeamLead,
  linkRequirementToMatchingTeamLeads,
} = require('../utils/teamLeadRequirements');
const {
  REQUIREMENT_TYPE_OPTIONS,
  isValidRequirementType,
  isRequirementWorkBlocked,
  normalizeRequirementType,
} = require('../utils/requirementType');
const { importRequirements } = require('../services/requirementImport.service');
const { importClients } = require('../services/clientImport.service');
const { hashPassword } = require('../utils/password');
const { activeUserFilter, INACTIVE_STATUS, isActiveUser } = require('../utils/userStatus');

module.exports = (app) => {
 app.get("/loggedinuserdata/:email", asyncHandler(async (req, res) => {
    const { email } = req.params;
    if (!email) {
        return res.status(400).json({ status: "Failed", msg: "Email is required" });
    }
    const loggedinuserdata = await NewUser.find({ Email: email }).select('-Password');
    res.json(loggedinuserdata);
}));

// app.post("/newUser",upload.array("ProfilePic"),async(req,res)=>{

//     let userArr=await NewUser.find().and({Email:req.body.Email});
//     if (userArr.length>0) {
//         res.json({status:"failure",msg:"Email already Exist❌"});
//     }else{
//     try{
//         let newUser = new NewUser({          
//             EmpCode:req.body.EmpCode,
//             EmployeeName:req.body.EmployeeName,
//             Email:req.body.Email,
//             Password:req.body.Password,
//             UserType:req.body.UserType,
//             ProfilePic:req.files[0].path,
//             Status:req.body.Status,
//             token:req.body.Token,
//             CreatedBy:req.body.CreatedBy,
//             Team:req.body.Team

//         });
//         await newUser.save();
//         res.json({status:"Success",msg:" User Created Successfully✅"});
//     }catch(error){
//         res.json({status:"Failed",error:error,msg:"Invalid Details ❌"});
//         console.log(error)
//     }
//     }
// }
// );

app.post("/newUser", upload.array("ProfilePic"), asyncHandler(async (req, res) => {
    const { EmpCode, EmployeeName, Email, Password, UserType, Status, Token, CreatedBy, Team } = req.body;

    if (!EmpCode || !EmployeeName || !Email || !Password || !UserType || !Status) {
        return res.status(400).json({ status: "failure", msg: "Required fields are missing" });
    }

    const userArr = await NewUser.find({ Email });
    if (userArr.length > 0) {
        return res.status(409).json({ status: "failure", msg: "Email already Exist❌" });
    }

    const profilePicPath = req.files?.length
        ? `/uploads/${path.basename(req.files[0].path)}`
        : '';

    const hashedPassword = await hashPassword(Password);

    const newUser = new NewUser({
        EmpCode,
        EmployeeName,
        Email,
        Password: hashedPassword,
        UserType,
        ...(profilePicPath ? { ProfilePic: profilePicPath } : {}),
        Status,
        token: Token,
        CreatedBy,
        Team
    });

    await newUser.save();
    res.json({ status: "Success", msg: "User Created Successfully✅" });
}));

app.get("/userDetailsHome", asyncHandler(async (req, res) => {
    const userDetailshome = await NewUser.find().select('-Password');
    res.json(userDetailshome);
}));
// Assign Clients to Users
app.get('/userDetailstoAssignClient/:clientId', async (req, res) => {
    const clientId = req.params.clientId;

    try {
        // Find users who do not have the specified client ID in their Clients array
        const userDetails = await NewUser.find({
            UserType: { $in: ["User", "TeamLead"] },
            Clients: { $ne: clientId },
            ...activeUserFilter,
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
            Clients: { $in: clientId },
            ...activeUserFilter,
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
            _id: { $in: teamIds },
            UserType: { $in: ["User"] },
            Requirements: { $ne: reqId },
            ...activeUserFilter,
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
            Requirements: reqId,
            _id: { $in: teamIds },
            ...activeUserFilter,
        });

        res.json(userDetails);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error });
    }
});
// Route to get users with UserType 'User'
app.get("/getUserDataToADDtoTeam/:id", async (req, res) => {
    try {
        const userId = req.params.id; // Get the user ID from the params

        // Step 1: Find the user by their ID and get their Team array
        const user = await NewUser.findById(userId, "Team");
        
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Step 2: Get all users with UserType 'User'
        const allUsers = await NewUser.find({ UserType: "User", ...activeUserFilter });

        const teamIds = (user.Team || []).map((memberId) => memberId.toString());

        const teamMembers = allUsers.filter((otherUser) =>
            teamIds.includes(otherUser._id.toString())
        );

        const nonTeamMembers = allUsers.filter((otherUser) =>
            !teamIds.includes(otherUser._id.toString())
        );

        // Step 5: Respond with team members and non-team members
        res.json({
            teamMembers: teamMembers,
            nonTeamMembers: nonTeamMembers
        });
    } catch (err) {
        // Handle errors (e.g., database issues)
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

app.delete("/deleteUser/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!validateObjectId(id, res, 'User ID')) return;

    const result = await NewUser.deleteOne({ _id: id });
    if (result.deletedCount === 0) {
        return res.status(404).json({ status: "failure", msg: "User not found" });
    }
    res.json({ status: "success", msg: "User Deleted Successfully✅" });
}));

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
        const teamUserDetails = await NewUser.find({
            _id: { $in: teamUserIds },
            ...activeUserFilter,
        });

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
app.get("/getUserdatatoUpdate/:id", async (req, res) => {
    try {
        // Step 1: Find the user by their ID
        const user = await NewUser.findById(req.params.id);

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Step 2: Get the team member IDs from the user's Team field
        const teamMemberIds = user.Team;

        // Step 3: Fetch the details of the team members based on the IDs in the Team array
        const teamMembers = await NewUser.find({
            _id: { $in: teamMemberIds },
            ...activeUserFilter,
        });

        // Step 4: Respond with both user details and team members details
        res.json({
            user: user,
            teamMembers: teamMembers
        });
    } catch (err) {
        // Handle errors
        console.error("Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

 // app.get("/getUserdatatoUpdate/:id",async(req,res)=>{
 //    let userdetails = await NewUser.findById({_id:req.params.id});
 //    res.json(userdetails); 
 // }) 
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

        // Merge team members only when usertype is TeamLead; replace selection and keep active users
        let teamObjectIds = currentUser.Team;
        if (usertype === "TeamLead" && Array.isArray(Team)) {
            const activeTeamMembers = await NewUser.find({
                _id: { $in: Team },
                UserType: 'User',
                ...activeUserFilter,
            }).select('_id');

            teamObjectIds = activeTeamMembers.map((member) => member._id);
        }

        const updatedUser = await NewUser.findByIdAndUpdate(
            id,
            { 
                EmployeeName: name,
                EmpCode: Code,
                Email: email,
                Status: status,
                UserType: usertype,
                ProfilePic: profile,
                Team: teamObjectIds,
            },
            { new: true }
        );

        if (updatedUser && status === INACTIVE_STATUS && currentUser.Status !== INACTIVE_STATUS) {
            await NewUser.updateMany(
                { Team: id },
                { $pull: { Team: id } }
            );
        }

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

 app.post("/addClient", upload.none(), asyncHandler(async (req, res) => {
    const { ClientCode, ClientName, Services, Location, Name, Spoc, MobileNumber, Email, Name1, Spoc1, MobileNumber1, Email1, Name2, Spoc2, MobileNumber2, Email2 } = req.body;

    if (!ClientCode || !ClientName) {
        return res.status(400).json({ status: "failure", msg: "Client Code and Client Name are required" });
    }

    const clientArr = await NewClient.find({ ClientCode });
    if (clientArr.length > 0) {
        return res.status(409).json({ status: "failure", msg: "Client Code already Exist❌" });
    }

    const newClient = new NewClient({
        ClientCode,
        ClientName,
        Services,
        Location,
        Name,
        Spoc,
        MobileNumber,
        Email,
        Name1,
        Spoc1,
        MobileNumber1,
        Email1,
        Name2,
        Spoc2,
        MobileNumber2,
        Email2,
    });

    await newClient.save();
    res.json({ status: "Success", msg: " Client Created Successfully✅" });
}));

app.get("/ClientsList", async (req, res) => {
    try {
        const [clientsList, allusersCount, activeUsers] = await Promise.all([
            NewClient.find(),
            NewUser.countDocuments({ UserType: { $in: ['User', 'TeamLead'] } }),
            NewUser.find({ Status: "Active", Clients: { $exists: true, $ne: [] } }).select('Clients'),
        ]);

        const clientUserCounts = clientsList.map((client) => {
            const userCount = activeUsers.filter((user) =>
                (user.Clients || []).some((clientId) => clientId.toString() === client._id.toString())
            ).length;

            return {
                clientId: client._id,
                clientCode: client.ClientCode,
                clientName: client.ClientName,
                userCount,
                userTypeCounts: allusersCount,
                clientDetails: {
                    location: client.Location,
                    typeOfService: client.Services,
                },
            };
        });

        res.json({ clientUserCounts });
    } catch (error) {
        res.status(500).json({ message: "Server Error", error });
    }
});

app.get("/allUsersCount", asyncHandler(async (req, res) => {
    const allusers = await NewUser.find({
        UserType: { $in: ['User', 'TeamLead'] }
    });
    res.json(allusers.length);
}));

app.get("/ClientsList/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!validateObjectId(id, res, 'Client ID')) return;

    const clientsList = await NewClient.find({ _id: id });
    if (clientsList.length === 0) {
        return res.status(404).json({ status: "Failed", msg: "Client not found" });
    }
    res.json(clientsList);
}));

app.get("/clientDetails", asyncHandler(async (req, res) => {
    const clientdetails = await NewClient.find();
    res.json(clientdetails);
}));

app.delete("/deleteClient/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!validateObjectId(id, res, 'Client ID')) return;

    const result = await NewClient.deleteOne({ _id: id });
    if (result.deletedCount === 0) {
        return res.status(404).json({ status: "failure", msg: "Client not found" });
    }
    res.json({ status: "success", msg: "Client Deleted Successfully✅" });
}));

 app.get("/getClientdatatoUpdate/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!validateObjectId(id, res, 'Client ID')) return;

    const clientdetails = await NewClient.findById(id);
    if (!clientdetails) {
        return res.status(404).json({ status: "Failed", msg: "Client not found" });
    }
    res.json(clientdetails);
}));
app.put("/UpdateClient/:id", async(req,res)=>{
    // console.log(req.params.id);
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
          requirementtype: normalizeRequirementType(req.body.requirmentType),
          update:req.body.update,
          uploadedBy:req.body.uploadedBy,
          clientId: req.body.clientId ? String(req.body.clientId) : '',
          numberOfPositions: req.body.numberOfPositions || 1,
          workMode: req.body.workMode || '',
          hiringManager: req.body.hiringManager || '',
          noticePeriodDays: req.body.noticePeriodDays || '',
          expectedOnboardDate: req.body.expectedOnboardDate || undefined,
          interviewProcess: req.body.interviewProcess || '',
          remarks: req.body.remarks || '',
        assessments:formattedAssessments
        });
        await newRequirment.save();
        if (req.body.uploadedBy) {
          await attachRequirementToTeamLead(req.body.uploadedBy, newRequirment._id);
        }
        await linkRequirementToMatchingTeamLeads(newRequirment);
        // console.log(req.body);
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
        const allRequirements = await getRequirementsForTeamLead(user, { withSource: true, lean: true });

        if (allRequirements.length === 0) {
            return res.json([]);
        }

        // Step 4: Get the user's Team (team members' IDs)
        const teamIds = user.Team || [];

        if (!teamIds.length) {
            const result = allRequirements.map((req) => ({
                requirement: req,
                requirementSource: req.requirementSource || 'Assigned',
                assignedCount: 0,
                totalTeamCount: 0,
            }));
            return res.json(result);
        }

        // Step 5: Find the team members from the NewUser schema
        const teamMembers = await NewUser.find({
            _id: { $in: teamIds },
            ...activeUserFilter,
        });

        if (!teamMembers || teamMembers.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No team members found" });
        }

        // Total team member count
        const totalTeamCount = teamMembers.length;

        // Step 6: Count assigned team members per requirement in one aggregation
        const teamObjectIds = teamMembers.map((member) => member._id);
        const assignmentCounts = await NewUser.aggregate([
            { $match: { _id: { $in: teamObjectIds }, Status: { $in: ['Active'] } } },
            { $unwind: '$Requirements' },
            { $group: { _id: '$Requirements', count: { $sum: 1 } } },
        ]);
        const assignedCountByReq = assignmentCounts.reduce((acc, item) => {
            acc[item._id.toString()] = item.count;
            return acc;
        }, {});

        const result = allRequirements.map((req) => ({
            requirement: req,
            requirementSource: req.requirementSource || 'Assigned',
            assignedCount: assignedCountByReq[req._id.toString()] || 0,
            totalTeamCount,
        }));

        // Step 7: Return the result (requirements along with the count of team members assigned to each requirement and total team count)
        res.json(result);

    } catch (err) {
        res.status(500).json({ status: "Error", msg: err.message });
    }
});


  
  app.get('/getHomeReqData/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: "Error", msg: "User not found" });
        }

        let requirements = [];
        if (user.UserType === 'TeamLead') {
            requirements = await getRequirementsForTeamLead(user, { withSource: true, lean: true });
        } else if (user.UserType === 'User') {
            requirements = await getRequirementsForUser(user, { lean: true });
        }

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
        res.json({ status: "Success", msg: "Requirement claimed successfully ✅" });
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

        // Check if the user can access this requirement
        const canAccess = await userCanAccessRequirement(user, requirement);

        if (!canAccess) {
            return res.status(403).json({ status: 'Failed', msg: 'You do not have access to this requirement' });
        }

        // Send the requirement data as response
        res.json(requirement);
    } catch (error) {
        console.error('Error fetching requirement:', error);
        res.status(500).json({ status: 'Failed', msg: 'Internal server error', error: error.message });
    }
});

// // app.post('/Candidates', uploadFields, async (req, res) => {
//     try {
//         const { reqId, recruiterId, candidate } = req.body;
//        // console.log(req.body);
//         // Log candidate data for debugging
//         // console.log('Received candidate string:', candidate);

//         // Check if candidate is provided
//         if (!candidate) {
//             throw new Error('Candidate data is missing or invalid');
//         }

//         // Parse candidate data
//         let candidateData;
//         try {
//             candidateData = JSON.parse(candidate);
//         } catch (parseError) {
//             throw new Error('Failed to parse candidate data: ' + parseError.message);
//         }

//         // Attach file paths if they exist
//         if (req.files['updatedResume']) candidateData.updatedResume = req.files['updatedResume'][0].path;
//         if (req.files['ornnovaProfile']) candidateData.ornnovaProfile = req.files['ornnovaProfile'][0].path;
//         if (req.files['candidateImage']) candidateData.candidateImage = req.files['candidateImage'][0].path;

//         // Check if a record with the same reqId and recruiterId exists
//         let existingCandidate = await CandidateModel.findOne({ reqId, recruiterId });

//         if (existingCandidate) {
//             // Add the new candidate to the existing candidates array
//             existingCandidate.candidates.push(candidateData);
//             await existingCandidate.save();
//         } else {
//             // Create a new document with the candidate details
//             const newCandidate = new CandidateModel({ reqId, recruiterId, candidates: [candidateData] });
//             await newCandidate.save();
//         }

//         res.status(200).json({ message: 'Candidate data saved successfully' });
//     } catch (error) {
//         console.error('Error saving candidate data:', error);
//         res.status(500).json({ message: 'Failed to save candidate data' });
//     }
// });

// Multer configuration for handling multiple file uploads
const uploadFields = upload.fields([
    { name: 'updatedResume', maxCount: 1 },
    { name: 'ornnovaProfile', maxCount: 1 },
    { name: 'candidateImage', maxCount: 1 }
]);

app.post('/Candidates', uploadFields, async (req, res) => {
    try {
        const { reqId, recruiterId, candidate } = req.body;

        // Check if candidate data is provided
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

        // Attach file paths if they exist and ensure proper formatting
if (req.files['updatedResume'] && req.files['updatedResume'][0]) {
    const filePath = req.files['updatedResume'][0].path;
    candidateData.updatedResume = path.posix.join('/uploads', path.basename(filePath)); // Use path.posix to normalize slashes
}

if (req.files['ornnovaProfile'] && req.files['ornnovaProfile'][0]) {
    const filePath = req.files['ornnovaProfile'][0].path;
    candidateData.ornnovaProfile = path.posix.join('/uploads', path.basename(filePath)); // Use path.posix to normalize slashes
}

if (req.files['candidateImage'] && req.files['candidateImage'][0]) {
    const filePath = req.files['candidateImage'][0].path;
    candidateData.candidateImage = path.posix.join('/uploads', path.basename(filePath)); // Use path.posix to normalize slashes
}

        if (candidateData.savedStatus === 'Uploaded') {
            const duplicate = await checkDuplicateCandidate({
                email: candidateData.email,
                mobileNumber: candidateData.mobileNumber,
                reqId,
            });
            if (duplicate.isDuplicate) {
                return res.status(409).json({
                    status: 'Duplicate',
                    message: duplicate.message,
                    match: duplicate.match,
                });
            }
        }


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


// Batch candidate counts for a recruiter across multiple requirements
app.get('/candidateCounts/:userId', async (req, res) => {
    const { userId } = req.params;
    const reqIds = req.query.reqIds ? req.query.reqIds.split(',').filter(Boolean) : null;

    if (!userId) {
        return res.status(400).json({ error: 'UserID is required' });
    }

    try {
        const query = { recruiterId: userId };
        if (reqIds && reqIds.length > 0) {
            query.reqId = { $in: reqIds };
        }

        const documents = await CandidateModel.find(query).select('reqId candidates').exec();
        const counts = {};

        documents.forEach((doc) => {
            counts[doc.reqId] = doc.candidates ? doc.candidates.length : 0;
        });

        res.json({ counts });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch candidate counts' });
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
        // Log the received ID to check
        console.log("Received ID:", id);

        // Find all documents with the given reqId
        const requirements = await CandidateModel.find({ reqId: id }).exec();

        // Log the fetched requirements to check if data is returned
        console.log("Requirements found:", requirements);

        if (requirements.length > 0) {
            // Aggregate only candidates with savedStatus "Uploaded" and status not in rejected statuses
            const allCandidates = requirements.flatMap(req => {
                // Log candidates to inspect their structure
                console.log("Candidates in requirement:", req.candidates);

                return req.candidates.filter(candidate => 
                    candidate.savedStatus === 'Uploaded' && 
                    candidate.Status.every(statusObj => 
                        !['Client Rejected', 'L1 Rejected', 'L2 Rejected', 'Rejected', 'Declined'].includes(statusObj.Status)
                    )
                );
            });

            // Log the filtered candidates to see if any match
            console.log("Filtered candidates:", allCandidates);

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

// Expanding of User Uploads
app.get('/userUploads/:reqId/:userId', async (req, res) => {
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
                // .filter(candidate => candidate.savedStatus === 'Uploaded') // Filter candidates by savedStatus
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

// Fetch candidates uploaded by a specific user for a particular requirement
// app.get('/userUploads/:reqId/:userId', async (req, res) => {
//     const { reqId, userId } = req.params;

//     if (!reqId || !userId) {
//         return res.status(400).json({ error: 'reqId and userId are required' });
//     }

//     try {
//         // Find the requirement by reqId
//         const requirement = await CandidateModel.findOne({ reqId }).exec();

//         if (!requirement) {
//             return res.status(404).json({ message: `No requirement found with reqId: ${reqId}` });
//         }

//         // Filter candidates uploaded by the specified user (recruiterId == userId)
//         const userCandidates = requirement.candidates.filter(candidate =>
//             candidate.recruiterId.includes(userId)
//         );

//         if (userCandidates.length === 0) {
//             return res.status(404).json({ message: `No candidates found uploaded by userId: ${userId}` });
//         }

//         res.status(200).json({
//             reqId,
//             userId,
//             candidates: userCandidates,
//         });
//     } catch (error) {
//         console.error('Server Error:', error);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// });




// Define a route to get candidates by recruiter ID
app.get('/api/candidates', async (req, res) => {
    try {
        const { recruiterId, reqId } = req.query;
        // console.log('Fetching candidates with:', { recruiterId, reqId });

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
    const { userId, clientId } = req.params;

    // Ensure clientId is in the correct format
    if (!isValidObjectId(clientId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Client ID format.' });
    }

    if (!clientId) {
        return res.status(400).json({ status: 'error', msg: 'Client ID is required.' });
    }

    try {
        // Validate userId format
        if (!isValidObjectId(userId)) {
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

            sendEmailSafely({
                from: process.env.EMAIL,
                to: user.Email,
                subject: 'Client Assigned To You',
                text: `Dear ${user.EmployeeName},\n\nA new client has been assigned to you.\n\n Check Here: https://ornnova.com/HR/`,
            });

            return res.json({ status: 'success', msg: 'Client assigned successfully ✅' });
        } else {
            return res.json({ status: 'error', msg: 'Client already assigned to this user 😊' });
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
    if (!isValidObjectId(clientId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Client ID format.' });
    }

    if (!clientId) {
        return res.status(400).json({ status: 'error', msg: 'Client ID is required.' });
    }

    try {
        // Validate userId format
        if (!isValidObjectId(userId)) {
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
            _id: { $in: userData.Team },
            ...activeUserFilter,
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
    if (!isValidObjectId(requirementId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Requirement ID format.' });
    }

    if (!requirementId) {
        return res.status(400).json({ status: 'error', msg: 'Requirement ID is required.' });
    }

    try {
        // Validate userId format
        if (!isValidObjectId(userId)) {
            return res.status(400).json({ status: 'error', msg: 'Invalid User ID format.' });
        }

        // Find the user by userId
        const user = await NewUser.findById(userId);

        if (!user) {
            return res.status(404).json({ status: 'error', msg: 'User not found.' });
        }

        if (!isActiveUser(user)) {
            return res.status(400).json({ status: 'error', msg: 'Cannot assign requirements to an inactive user.' });
        }

        const alreadyAssigned = (user.Requirements || []).some(
            (id) => id.toString() === requirementId.toString()
        );

        if (alreadyAssigned) {
            return res.json({ status: 'error', msg: 'Requirement already assigned to this user 😊' });
        }

        user.Requirements.push(requirementId);
        await user.save();

        const requirement = await NewRequirment.findById(requirementId);
        if (requirement) {
            const userIdStr = userId.toString();
            const alreadyClaimed = (requirement.claimedBy || []).some(
                (claim) => claim.userId === userIdStr
            );

            if (!alreadyClaimed) {
                requirement.claimedBy.push({
                    userId: userIdStr,
                    claimedDate: new Date(),
                });
            }

            requirement.update = 'Old';
            await requirement.save();
        }

        sendEmailSafely({
            from: process.env.EMAIL,
            to: user.Email,
            subject: 'Requirement Assigned To You',
            text: `Dear ${user.EmployeeName},\n\nA new requirement has been successfully assigned to you.\n\n Check Here: https://ornnova.com/HR/`,
        });

        return res.json({ status: 'success', msg: 'Requirement assigned successfully ✅' });
    } catch (error) {
        console.error('Error assigning requirement:', error);
        res.status(500).json({ status: 'error', msg: 'An error occurred while assigning the requirement.' });
    }
});
// Unassign Requirement from User

app.post('/unassignReq/:userId/:requirementId', async (req, res) => {
    const { userId, requirementId } = req.params;

    // Ensure requirementId is in the correct format
    if (!isValidObjectId(requirementId)) {
        return res.status(400).json({ status: 'error', msg: 'Invalid Requirement ID format.' });
    }

    if (!requirementId) {
        return res.status(400).json({ status: 'error', msg: 'Requirement ID is required.' });
    }

    try {
        // Validate userId format
        if (!isValidObjectId(userId)) {
            return res.status(400).json({ status: 'error', msg: 'Invalid User ID format.' });
        }

        // Find the user by userId
        const user = await NewUser.findById(userId);
        if (!user) {
            return res.status(404).json({ status: 'error', msg: 'User not found.' });
        }

        // Check if the user is assigned to this requirement
        const requirementAssigned = user.Requirements.includes(requirementId);
        if (!requirementAssigned) {
            return res.status(400).json({
                status: 'error',
                msg: 'This user is not assigned to this requirement.',
            });
        }

        // Check if the user has uploaded any candidates for the specific requirement
        const requirement = await CandidateModel.findOne({
            reqId: requirementId,
            recruiterId: userId
        });

        if (requirement && requirement.candidates.length > 0) {
            return res.status(400).json({
                status: 'error',
                msg: "Cannot unassign this requirement as candidates are uploaded by this user.",
            });
        }

        // Remove the requirementId from the user's Requirements array
        user.Requirements = user.Requirements.filter(reqId => reqId.toString() !== requirementId);
        await user.save();

        // Update NewRequirement schema to remove userId from claimedBy field
        await NewRequirment.updateOne(
            { _id: requirementId },
            { $pull: { claimedBy: { userId } } }  // Pulls userId from claimedBy array
        );

        res.json({ status: 'success', msg: 'Requirement unassigned successfully ✅' });
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

        // Step 2: Get the team members' IDs, including the user ID for comparison
        const teamMemberIds = [userId, ...(user.Team || [])];
        const activeMembers = await NewUser.find({
            _id: { $in: teamMemberIds },
            ...activeUserFilter,
        }).select('_id EmployeeName');
        const activeMemberIds = activeMembers.map((member) => member._id.toString());

        if (activeMemberIds.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No active team members associated with this user" });
        }

        const teamRequirements = await CandidateModel.find({
            recruiterId: { $in: activeMemberIds },
            reqId : { $in: user.Requirements }
        });
       

        if (teamRequirements.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No requirements found for user or team members" });
        }

        // Step 4: Initialize counters and arrays to store data
        let totalCandidatesCount = 0;
        let todaysCandidatesCount = 0;
        let totalCandidatesData = [];
        let todaysCandidatesData = [];
        let recruiterStats = []; // Array to hold stats for each recruiter

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set time to midnight for today's comparison

        // Step 5: Iterate through each team member (recruiter)
        for (const recruiterId of activeMemberIds) {
            let recruiterTotalCandidates = 0;
            let recruiterTodaysCandidates = 0;
            let recruiterCandidatesData = [];
            let recruiterTodaysData = [];

            // Fetch recruiter details from NewUser schema
            const recruiterDetails = await NewUser.findById(recruiterId);

            if (!recruiterDetails) {
                continue; // Skip if recruiter is not found
            }

            // Filter requirements for the current recruiter
            const recruiterRequirements = teamRequirements.filter(req => req.recruiterId.toString() === recruiterId.toString());

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


// app.get('/getRequirementsCandidatesCount/:recruiterId/:userId', async (req, res) => {
//     const { recruiterId } = req.params;

//     try {
//         // Step 1: Fetch all requirements related to the recruiter
//         const recruiterRequirements = await CandidateModel.find({
//             recruiterId: recruiterId
//         });

//         if (recruiterRequirements.length === 0) {
//             return res.status(404).json({ status: "Error", msg: "No requirements found for this recruiter" });
//         }

//         // Step 2: Collect reqIds from the recruiterRequirements
//         const reqIds = recruiterRequirements.map(req => req.reqId);

//         // Step 3: Fetch requirement details using reqIds
//         const requirements = await NewRequirment.find({
//             _id: { $in: reqIds } // Convert string ids to ObjectId
//         });

//         // Step 4: Create a map to store candidate counts for each reqId
//         const reqIdToCandidateCount = {};

//         // Populate the candidate counts, only counting candidates with savedStatus as "Uploaded"
//         recruiterRequirements.forEach(req => {
//             const uploadedCandidatesCount = req.candidates.filter(candidate => candidate.savedStatus === "Uploaded").length;
//             if (reqIdToCandidateCount[req.reqId]) {
//                 reqIdToCandidateCount[req.reqId] += uploadedCandidatesCount;
//             } else {
//                 reqIdToCandidateCount[req.reqId] = uploadedCandidatesCount;
//             }
//         });

//         // Step 5: Attach candidate counts to the requirement details
//         const requirementsWithCounts = requirements.map(req => ({
//             ...req.toObject(),
//             candidateCount: reqIdToCandidateCount[req._id.toString()] || 0
//         }));

//         // Step 6: Send the response with the requirements and candidate counts
//         res.json({
//             status: "Success",
//             requirements: requirementsWithCounts
//         });
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ status: "Error", msg: err.message });
//     }
// }); 

app.get('/getRequirementsCandidatesCount/:recruiterId/:userId', async (req, res) => {
    const { recruiterId, userId } = req.params;

    try {
        // Step 1: Fetch user data from NewUser schema to get the user's requirements
        const userData = await NewUser.findOne({ _id: userId });

        // Step 2: Fetch recruiter data from NewUser schema to get the recruiter's requirements
        const recruiterData = await NewUser.findOne({ _id: recruiterId });

        // Check if both user and recruiter data are found
        if (!userData || !recruiterData) {
            return res.status(404).json({ status: "Error", msg: "User or recruiter not found" });
        }

        // Step 3: Get both the user's and recruiter's Requirements
        const userRequirements = userData.Requirements;
        const recruiterRequirements = recruiterData.Requirements;

        // Step 4: Find the common requirements by comparing the reqIds in both arrays
        const commonRequirements = userRequirements.filter(userReq => {
            return recruiterRequirements.some(recruiterReq => recruiterReq._id.toString() === userReq._id.toString());
        });

        // If no matching requirements are found
        if (commonRequirements.length === 0) {
            return res.status(404).json({ status: "Error", msg: "No common requirements found for the user and recruiter" });
        }

        // Step 5: Fetch the full details of the common requirements using their reqIds
        const reqIds = commonRequirements.map(req => req._id);
        const requirements = await NewRequirment.find({
            _id: { $in: reqIds } // Find requirements with matching _id in the reqIds
        });

        // Step 6: For each requirement, calculate the candidate count based on the length of the candidates array
        const requirementsWithCandidateCount = await Promise.all(requirements.map(async (req) => {
            // Find the specific requirement in the recruiterData
            const recruiterReq = recruiterRequirements.find(rReq => rReq._id.toString() === req._id.toString());

            // Query the CandidateModel to find the number of candidates for each requirement and recruiter
            const candidateData = await CandidateModel.findOne({
                reqId: req._id,
                recruiterId: recruiterId
            });

            // If candidate data exists, filter the candidates whose savedStatus is "Uploaded" and get the count
            const uploadedCandidatesCount = candidateData && Array.isArray(candidateData.candidates)
                ? candidateData.candidates.filter(candidate => candidate.savedStatus === "Uploaded").length
                : 0;

            return {
                ...req.toObject(),
                candidateCount: uploadedCandidatesCount
            };
        }));

        // Step 7: Send the response with the matching requirements and candidate counts
        res.json({
            status: "Success",
            requirements: requirementsWithCandidateCount
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

        const teamIds = user.Team || [];
        const teamUsers = await NewUser.find({ _id: { $in: teamIds }, ...activeUserFilter });
        const activeTeamIds = teamUsers.map((teamUser) => teamUser._id);
        const allRequirements = await getRequirementsForTeamLead(user, { withSource: true, lean: true });

        if (!allRequirements.length) {
            return res.json([]);
        }

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
                const assignedUsersForThisRequirement = teamUsers.filter((teamUser) =>
                    (teamUser.Requirements || []).some(
                        (reqId) => reqId.toString() === requirementId.toString()
                    )
                );

                const usernamesForThisRequirement = assignedUsersForThisRequirement.map(user => user.EmployeeName);
                const userCountForThisRequirement = assignedUsersForThisRequirement.length;

                // Step 6: Get candidate details with savedStatus filter applied only where needed
                const requirementWithCandidates = await CandidateModel.find({
                    reqId: requirementId,
                    recruiterId: {
                        $in: [...activeTeamIds, userId]
                    }
                }).select('candidates reqId recruiterId');

                // All user candidates regardless of savedStatus
                const totalUserCandidatesDetails = requirementWithCandidates ? requirementWithCandidates.flatMap(req =>
                    req.candidates.filter(candidate => req.recruiterId.toString() === userId)
                ) : [];
                const totalUserCandidatesCount = totalUserCandidatesDetails.length;

                // Filtered user and team candidates by `savedStatus: "Uploaded"`
                const userCandidates = totalUserCandidatesDetails.filter(candidate => candidate.savedStatus === 'Uploaded');

                const teamCandidates = requirementWithCandidates ? requirementWithCandidates.flatMap(req =>
                    req.candidates.filter(candidate =>
                        activeTeamIds.some((teamId) => teamId.toString() === req.recruiterId.toString()) && candidate.savedStatus === 'Uploaded'
                    )
                ) : [];

                // Total candidate count with "Uploaded" status only
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

                // Combine user and team candidates into totalCandidatesDetails
                const totalCandidatesDetails = [...userCandidates, ...teamCandidates];

                // Combine today's user and team candidates
                const combinedTodayCandidates = [...todayUserCandidates, ...todayTeamCandidates];

                // Step 9: Return the details
                return {
                    requirementDetails: requirement,
                    requirementSource: requirement.requirementSource || 'Assigned',
                    userCount: userCountForThisRequirement,
                    assignedUsernames: usernamesForThisRequirement,
                    totalCandidateCount: totalCandidateCount,
                    todayCandidateCount: todayCandidateCount,
                    userCandidatesCount: userCandidates.length,
                    teamCandidatesCount: teamCandidates.length, // Only "Uploaded" team candidates are counted here
                    todayUserCandidates: todayUserCandidates,
                    todayTeamCandidates: todayTeamCandidates, // Only "Uploaded" team candidates for today
                    totalUserCandidatesDetails: totalUserCandidatesDetails, // Both "Saved" and "Uploaded" user candidates
                    totalUserCandidatesCount: totalUserCandidatesCount, // Count of both "Saved" and "Uploaded" user candidates
                    totalTeamCandidatesDetails: teamCandidates, // Only "Uploaded" team candidates
                    totalCandidatesDetails: totalCandidatesDetails, // All "Uploaded" candidates (user + team)
                    combinedTodayCandidates: combinedTodayCandidates // Combined today "Uploaded" candidates (user + team)
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
    // console.log(id)
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
    const { status, interviewDate, interviewTime } = req.body;
    const INTERVIEW_SCHEDULE_STATUSES = ['L1 Schedule', 'L2 Schedule', 'L1 Pending', 'L2 Pending'];
    const normalizedStatus = status === 'L1 Pending'
        ? 'L1 Schedule'
        : status === 'L2 Pending'
            ? 'L2 Schedule'
            : status;

    if (!status) {
        return res.status(400).json({ message: 'Status is required' });
    }

    if (INTERVIEW_SCHEDULE_STATUSES.includes(status) && !interviewDate) {
        return res.status(400).json({
            message: 'Interview date is required when status is L1 Schedule or L2 Schedule.',
        });
    }

    try {
        const updateOps = {
            $push: {
                'candidates.$.Status': {
                    Status: normalizedStatus,
                    Date: new Date(),
                },
            },
        };

        if (interviewDate) {
            updateOps.$set = {
                'candidates.$.interviewDate': interviewDate,
                'candidates.$.interviewTime': interviewTime || '',
            };
        }

        const updatedMain = await CandidateModel.findOneAndUpdate(
            { 'candidates._id': candidateId },
            updateOps,
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
        const [requirements, allUsers, allCandidateDocs] = await Promise.all([
            NewRequirment.find(),
            NewUser.find(),
            CandidateModel.find(),
        ]);

        const candidatesByReqId = allCandidateDocs.reduce((acc, doc) => {
            const reqKey = doc.reqId?.toString();
            if (!reqKey) return acc;
            if (!acc[reqKey]) acc[reqKey] = [];
            acc[reqKey].push(doc);
            return acc;
        }, {});

        const enrichedRequirements = requirements.map((requirement) => {
            const clientId = requirement.clientId;
            const reqId = requirement._id.toString();

            const users = allUsers.filter((user) =>
                (user.Clients || []).some((id) => id.toString() === clientId?.toString()) ||
                (user.Requirements || []).some((id) => id.toString() === reqId)
            );

            const relatedDocuments = candidatesByReqId[reqId] || [];
            const requirementData = relatedDocuments[0] || null;
            const candidates = requirementData ? requirementData.candidates : [];

            const uploadedCandidates = candidates.filter((candidate) =>
                candidate.savedStatus === "Uploaded"
            );

            const allCandidates = relatedDocuments.reduce((acc, doc) => {
                return acc.concat(doc.candidates || []);
            }, []);

            const noactionCandidates = allCandidates.filter((candidate) =>
                candidate.savedStatus === "Uploaded" &&
                (
                    !candidate.Status ||
                    candidate.Status.length === 0 ||
                    candidate.Status.every((status) =>
                        !status.Status || status.Status.length === 0
                    )
                )
            );

            return {
                ...requirement.toObject(),
                userCount: users.length,
                userDetails: users,
                uploadedCandidates,
                noactionCandidates,
                noactionCandidatesCount: noactionCandidates.length,
            };
        });

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

        if (!isValidObjectId(id)) {
            return res.status(400).json({ status: "Error", msg: "Invalid requirement ID" });
        }

        // Fetch the specific requirement by ID
        const requirement = await NewRequirment.findById(id);

        if (!requirement) {
            return res.status(404).json({ status: "Error", msg: "Requirement not found" });
        }

        // Get the clientId and reqId from the requirement
        const clientId = requirement.clientId;
        const reqId = requirement._id; // Assuming this is the reqId

        // Find users who are not already assigned to this requirement
        const remainingUsers = await NewUser.find({
            Requirements: { $nin: [reqId] },
            UserType: { $in: ['User', 'TeamLead'] },
            ...activeUserFilter,
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

// Phase 1 — Admin analytics (read-only)
app.get('/api/admin/analytics', asyncHandler(async (req, res) => {
    const data = await getAdminAnalytics();
    res.json(data);
}));

app.get('/api/admin/requirements/:id/funnel', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [requirements, candidateDocs, users] = await Promise.all([
        NewRequirment.find().lean(),
        CandidateModel.find().lean(),
        NewUser.find({ UserType: { $in: ['User', 'TeamLead'] } }).lean(),
    ]);

    const rows = flattenUploadedCandidates(candidateDocs);
    const userMap = new Map(users.map((user) => [user._id.toString(), user]));
    const funnel = computeRequirementFunnel(id, requirements, rows, userMap);

    if (!funnel) {
        return res.status(404).json({ status: 'Error', msg: 'Requirement not found' });
    }

    res.json({ status: 'Success', funnel });
}));

app.post('/api/candidates/check-duplicate', asyncHandler(async (req, res) => {
    const { email, mobileNumber, clientId, reqId } = req.body;
    const result = await checkDuplicateCandidate({ email, mobileNumber, clientId, reqId });
    res.json({ status: 'Success', ...result });
}));

app.get('/api/requirements/:id/summary', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const requirement = await NewRequirment.findById(id).lean();
    if (!requirement) {
        return res.status(404).json({ status: 'Error', msg: 'Requirement not found' });
    }

    const [candidateDocs, users] = await Promise.all([
        CandidateModel.find({ reqId: id }).lean(),
        NewUser.find({ UserType: { $in: ['User', 'TeamLead'] } }).lean(),
    ]);

    const rows = flattenUploadedCandidates(candidateDocs);
    const userMap = new Map(users.map((user) => [user._id.toString(), user]));
    const funnel = computeRequirementFunnel(id, [requirement], rows, userMap);
    const recruiterName = users.find((u) => u._id.toString() === requirement.uploadedBy)?.EmployeeName || '—';

    res.json({
        status: 'Success',
        summary: {
            regId: requirement.regId,
            client: requirement.client,
            role: requirement.role,
            positions: requirement.numberOfPositions || 1,
            experience: `${requirement.yearsExperience || '—'} - ${requirement.relevantExperience || '—'}`,
            ctc: requirement.sourceCtc,
            recruiter: recruiterName,
            requirementType: normalizeRequirementType(requirement.requirementtype),
            workMode: requirement.workMode,
            profilesShared: funnel?.profilesShared || 0,
            interviews: funnel?.interviews || 0,
            offersReleased: funnel?.offersReleased || 0,
            joined: funnel?.joined || 0,
        },
        funnel,
    });
}));

app.post('/api/clients/import', upload.none(), asyncHandler(async (req, res) => {
    const { rows = [] } = req.body;
    const parsedRows = Array.isArray(rows) ? rows : [];
    const result = await importClients(parsedRows);
    const statusCode = result.imported > 0 ? 200 : 400;
    res.status(statusCode).json(result);
}));

app.post('/api/requirements/import', upload.none(), asyncHandler(async (req, res) => {
    const { rows = [], uploadedBy = '' } = req.body;
    const parsedRows = Array.isArray(rows) ? rows : [];
    const result = await importRequirements(parsedRows, { uploadedBy });
    const statusCode = result.imported > 0 ? 200 : 400;
    res.status(statusCode).json(result);
}));

app.patch('/api/requirements/:id/requirement-type', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { requirementtype } = req.body;

    if (!isValidRequirementType(requirementtype)) {
        return res.status(400).json({
            status: 'Error',
            msg: `Invalid requirement type. Allowed: ${REQUIREMENT_TYPE_OPTIONS.join(', ')}`,
        });
    }

    const requirement = await NewRequirment.findByIdAndUpdate(
        id,
        { requirementtype: normalizeRequirementType(requirementtype) },
        { new: true, runValidators: true }
    );

    if (!requirement) {
        return res.status(404).json({ status: 'Error', msg: 'Requirement not found.' });
    }

    res.json({ status: 'Success', msg: 'Requirement type updated.', requirement });
}));

// Status tracking dashboard (read-only, role-scoped)
app.get('/api/tracking/summary', asyncHandler(async (req, res) => {
    const { userId, teamLeadId, recruiterId, from, to } = req.query;
    if (!userId) {
        return res.status(400).json({ status: 'Error', msg: 'userId is required.' });
    }
    const data = await getTrackingSummary(userId, {
        teamLeadId: teamLeadId || '',
        recruiterId: recruiterId || '',
        fromDate: from || '',
        toDate: to || '',
    });
    if (data.status === 'Error') {
        return res.status(404).json(data);
    }
    res.json(data);
}));

app.get('/api/tracking/stages/:stageKey/candidates', asyncHandler(async (req, res) => {
    const { stageKey } = req.params;
    const { userId, teamLeadId, recruiterId, from, to } = req.query;
    if (!userId) {
        return res.status(400).json({ status: 'Error', msg: 'userId is required.' });
    }
    const data = await getStageCandidates(userId, stageKey, {
        teamLeadId: teamLeadId || '',
        recruiterId: recruiterId || '',
        fromDate: from || '',
        toDate: to || '',
    });
    if (data.status === 'Error') {
        const statusCode = data.msg === 'Invalid stage key.' ? 400 : 404;
        return res.status(statusCode).json(data);
    }
    res.json(data);
}));

// Phase 3 — Operational workflows
app.get('/api/admin/today-monitor', asyncHandler(async (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ status: 'Error', msg: 'userId is required.' });
    }
    const data = await getTodayMonitorForUser(userId);
    res.json(data);
}));

app.get('/api/teamlead/today-monitor/:userId', asyncHandler(async (req, res) => {
    const data = await getTodayMonitorForUser(req.params.userId);
    res.json(data);
}));

app.get('/api/work/today-monitor/:userId', asyncHandler(async (req, res) => {
    const data = await getTodayMonitorForUser(req.params.userId);
    res.json(data);
}));

app.get('/api/interviews/upcoming', asyncHandler(async (req, res) => {
    const userId = req.query.userId;
    const days = Number(req.query.days) || 7;
    if (!userId) {
        return res.status(400).json({ status: 'Error', msg: 'userId is required.' });
    }
    const data = await getUpcomingInterviewsForUser(userId, days);
    res.json(data);
}));

app.get('/api/notifications/:userId', asyncHandler(async (req, res) => {
    const data = await getNotificationsForUser(req.params.userId);
    res.json(data);
}));

app.patch('/api/candidates/:candidateId/schedule-interview', asyncHandler(async (req, res) => {
    const { candidateId } = req.params;
    const { interviewDate, interviewTime } = req.body;

    if (!interviewDate) {
        return res.status(400).json({ status: 'Error', msg: 'interviewDate is required.' });
    }

    const mainDoc = await CandidateModel.findOne({ 'candidates._id': candidateId });
    if (!mainDoc) {
        return res.status(404).json({ status: 'Error', msg: 'Candidate not found.' });
    }

    const candidateIndex = mainDoc.candidates.findIndex(
        (candidate) => candidate._id.toString() === candidateId
    );
    if (candidateIndex === -1) {
        return res.status(404).json({ status: 'Error', msg: 'Candidate not found in the array.' });
    }

    mainDoc.candidates[candidateIndex].interviewDate = interviewDate;
    mainDoc.candidates[candidateIndex].interviewTime = interviewTime || '';
    await mainDoc.save();

    res.json({
        status: 'Success',
        msg: 'Interview scheduled successfully.',
        candidate: mainDoc.candidates[candidateIndex],
    });
}));

app.patch('/api/requirements/:id/hold', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const requirement = await NewRequirment.findByIdAndUpdate(
        id,
        { requirementtype: 'Hold' },
        { new: true, runValidators: true }
    );
    if (!requirement) {
        return res.status(404).json({ status: 'Error', msg: 'Requirement not found.' });
    }
    res.json({ status: 'Success', msg: 'Requirement moved to Hold.', requirement });
}));

};
