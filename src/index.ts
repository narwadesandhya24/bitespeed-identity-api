import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Define expected structure for incoming /identify requests
interface IdentifyRequestBody {
  email?: string;
  phoneNumber?: string;
}

// Define structure for our response to the client
interface ContactResponse {
  primaryContactId: number;
  emails: string[];
  phoneNumbers: string[];
  secondaryContactIds: number[];
}

// Basic root route just to verify the server is running
app.get('/', (_req: Request, res: Response) => {
  res.send('Hello from Bitespeed Identity API!');
});

// Main endpoint that handles identity reconciliation
app.post(
  '/identify',
  async (
    req: Request<{}, {}, IdentifyRequestBody>,
    res: Response<ContactResponse | { error: string }>
  ) => {
    const { email, phoneNumber } = req.body;

    // If neither email nor phone is provided, we can't proceed
    if (!email && !phoneNumber) {
      return res.status(400).json({ error: 'Email or phoneNumber is required' });
    }

    try {
      // Step 1: Find all contacts that match email or phoneNumber
      const matchedContacts = await prisma.contact.findMany({
        where: {
          OR: [
            ...(email ? [{ email }] : []),
            ...(phoneNumber ? [{ phoneNumber }] : [])
          ]
        },
        orderBy: {
          createdAt: 'asc'
        }
      });

      let primaryContact = null;

      if (matchedContacts.length === 0) {
        // Step 2: If no match found, create a new primary contact
        const newContact = await prisma.contact.create({
          data: {
            email,
            phoneNumber,
            linkPrecedence: 'primary'
          }
        });

        return res.json({
          primaryContactId: newContact.id,
          emails: email ? [email] : [],
          phoneNumbers: phoneNumber ? [phoneNumber] : [],
          secondaryContactIds: []
        });
      }

      // Step 3: Identify the oldest primary
      const allLinkedIds = matchedContacts
        .map(c => (c.linkPrecedence === 'primary' ? c.id : c.linkedId))
        .filter(Boolean) as number[];

      const rootPrimaryId = Math.min(...allLinkedIds);

       // Get details of the root primary contact
      primaryContact = await prisma.contact.findUnique({
        where: { id: rootPrimaryId }
      });

      // Step 4: Fetch all contacts linked to the primary (including indirectly)
      const allContacts = await prisma.contact.findMany({
        where: {
          OR: [
            { id: rootPrimaryId },
            { linkedId: rootPrimaryId }
          ]
        },
        orderBy: { createdAt: 'asc' }
      });

      // Step 5: Create a new secondary contact if new email/phone isn't present
      const existingEmails = allContacts.map(c => c.email);
      const existingPhones = allContacts.map(c => c.phoneNumber);

      const shouldCreateNewContact =
        (email && !existingEmails.includes(email)) ||
        (phoneNumber && !existingPhones.includes(phoneNumber));

      if (shouldCreateNewContact) {
        await prisma.contact.create({
          data: {
            email,
            phoneNumber,
            linkPrecedence: 'secondary',
            linkedId: rootPrimaryId
          }
        });
      }

      // Step 6: Pull the full updated list of related contacts again
      const updatedContacts = await prisma.contact.findMany({
        where: {
          OR: [
            { id: rootPrimaryId },
            { linkedId: rootPrimaryId }
          ]
        }
      });
      
      // Remove duplicates and nulls to prepare final response data
      const emails = Array.from(
        new Set(updatedContacts.map(c => c.email).filter(Boolean))
      ) as string[];

      const phoneNumbers = Array.from(
        new Set(updatedContacts.map(c => c.phoneNumber).filter(Boolean))
      ) as string[];

      const secondaryContactIds = updatedContacts
        .filter(c => c.linkPrecedence === 'secondary')
        .map(c => c.id);

      return res.json({
        primaryContactId: rootPrimaryId,
        emails,
        phoneNumbers,
        secondaryContactIds
      });
    } catch (error) {
      console.error('Error in /identify:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);
// start the server 
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
